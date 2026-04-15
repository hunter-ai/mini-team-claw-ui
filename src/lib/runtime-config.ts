import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getStartupEnv } from "@/lib/env";

const RUNTIME_CONFIG_ID = "default";
const ENCRYPTION_CONTEXT = "app-runtime-config";
const gatewayAuthModeSchema = z.enum(["token", "password"]);

const runtimeConfigSchema = z.object({
  gatewayUrl: z.string().url().refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
    message: "Gateway URL must use ws:// or wss://",
  }),
  gatewayAuthMode: gatewayAuthModeSchema.default("token"),
  gatewayToken: z.string().optional(),
  gatewayPassword: z.string().optional(),
  appUrl: z.string().url().optional().or(z.literal("")),
});

type RuntimeConfigInput = z.input<typeof runtimeConfigSchema>;

type RuntimeConfigRecord = {
  gatewayUrl: string;
  gatewayAuthMode: z.infer<typeof gatewayAuthModeSchema>;
  gatewayToken: string;
  gatewayTokenConfigured: boolean;
  gatewayPassword: string;
  gatewayPasswordConfigured: boolean;
  gatewayCredentialConfigured: boolean;
  appUrl: string | null;
  source: "db" | "env-fallback";
};

export type GatewayAuthMode = z.infer<typeof gatewayAuthModeSchema>;

function base64UrlEncode(value: Buffer) {
  return value.toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url");
}

function encryptionKey() {
  return createHash("sha256")
    .update(`${ENCRYPTION_CONTEXT}:${getStartupEnv().SESSION_SECRET}`)
    .digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
}

function decrypt(value: string) {
  const [ivPart, tagPart, ciphertextPart] = value.split(".");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Corrupted runtime config secret");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), base64UrlDecode(ivPart));
  decipher.setAuthTag(base64UrlDecode(tagPart));
  const plaintext = Buffer.concat([
    decipher.update(base64UrlDecode(ciphertextPart)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function validateRuntimeConfig(
  input: RuntimeConfigInput,
  options?: { preserveGatewayCredential?: boolean },
) {
  const parsed = runtimeConfigSchema.parse(input);
  const gatewayAuthMode = parsed.gatewayAuthMode;
  const gatewayToken = parsed.gatewayToken?.trim() ?? "";
  const gatewayPassword = parsed.gatewayPassword?.trim() ?? "";
  const activeCredential = gatewayAuthMode === "password" ? gatewayPassword : gatewayToken;

  if (options?.preserveGatewayCredential !== true && !activeCredential) {
    throw new Error("Gateway credential is required");
  }

  return {
    ...parsed,
    gatewayAuthMode,
    gatewayToken,
    gatewayPassword,
  };
}

export function inferGatewayAuthMode(args: {
  gatewayAuthMode?: string | null;
  gatewayToken?: string | null;
  gatewayPassword?: string | null;
}) {
  const explicitMode = args.gatewayAuthMode?.trim();
  const gatewayToken = args.gatewayToken?.trim() ?? "";
  const gatewayPassword = args.gatewayPassword?.trim() ?? "";

  if (explicitMode === "token" || explicitMode === "password") {
    return explicitMode;
  }

  if (gatewayToken && !gatewayPassword) {
    return "token" as const;
  }

  if (gatewayPassword && !gatewayToken) {
    return "password" as const;
  }

  return null;
}

export async function getStoredRuntimeConfig() {
  const record = await prisma.appRuntimeConfig.findUnique({
    where: { id: RUNTIME_CONFIG_ID },
  });

  if (!record) {
    return null;
  }

  const gatewayToken = record.gatewayTokenEncrypted ? decrypt(record.gatewayTokenEncrypted) : "";
  const gatewayPassword = record.gatewayPasswordEncrypted ? decrypt(record.gatewayPasswordEncrypted) : "";
  const gatewayAuthMode =
    inferGatewayAuthMode({
      gatewayAuthMode: record.gatewayAuthMode,
      gatewayToken,
      gatewayPassword,
    }) ?? "token";

  return {
    gatewayUrl: record.gatewayUrl,
    gatewayAuthMode,
    gatewayToken,
    gatewayTokenConfigured: Boolean(record.gatewayTokenEncrypted),
    gatewayPassword,
    gatewayPasswordConfigured: Boolean(record.gatewayPasswordEncrypted),
    gatewayCredentialConfigured: gatewayAuthMode === "password"
      ? Boolean(record.gatewayPasswordEncrypted)
      : Boolean(record.gatewayTokenEncrypted),
    appUrl: normalizeOptionalString(record.appUrl),
    source: "db" as const,
  };
}

export async function getResolvedRuntimeConfig(): Promise<RuntimeConfigRecord | null> {
  const stored = await getStoredRuntimeConfig();
  if (stored) {
    return stored;
  }

  const env = getStartupEnv();
  if (!env.OPENCLAW_GATEWAY_URL) {
    return null;
  }

  const gatewayAuthMode = inferGatewayAuthMode({
    gatewayAuthMode: env.OPENCLAW_GATEWAY_AUTH_MODE,
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN,
    gatewayPassword: env.OPENCLAW_GATEWAY_PASSWORD,
  });
  const gatewayToken = env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? "";
  const gatewayPassword = env.OPENCLAW_GATEWAY_PASSWORD?.trim() ?? "";

  if (!gatewayAuthMode) {
    return null;
  }

  return {
    gatewayUrl: env.OPENCLAW_GATEWAY_URL,
    gatewayAuthMode,
    gatewayToken,
    gatewayTokenConfigured: Boolean(gatewayToken),
    gatewayPassword,
    gatewayPasswordConfigured: Boolean(gatewayPassword),
    gatewayCredentialConfigured: gatewayAuthMode === "password" ? Boolean(gatewayPassword) : Boolean(gatewayToken),
    appUrl: normalizeOptionalString(env.APP_URL),
    source: "env-fallback",
  };
}

export async function saveRuntimeConfig(
  input: RuntimeConfigInput,
  options?: { preserveGatewayCredential?: boolean },
) {
  const parsed = validateRuntimeConfig(input, {
    preserveGatewayCredential: options?.preserveGatewayCredential,
  });
  const gatewayToken = parsed.gatewayToken;
  const gatewayPassword = parsed.gatewayPassword;
  const appUrl = normalizeOptionalString(parsed.appUrl);
  const existing = await prisma.appRuntimeConfig.findUnique({
    where: { id: RUNTIME_CONFIG_ID },
    select: { gatewayTokenEncrypted: true, gatewayPasswordEncrypted: true },
  });
  const gatewayTokenEncrypted =
    gatewayToken
      ? encrypt(gatewayToken)
      : options?.preserveGatewayCredential || parsed.gatewayAuthMode === "password"
        ? (existing?.gatewayTokenEncrypted ?? null)
        : null;
  const gatewayPasswordEncrypted =
    gatewayPassword
      ? encrypt(gatewayPassword)
      : options?.preserveGatewayCredential || parsed.gatewayAuthMode === "token"
        ? (existing?.gatewayPasswordEncrypted ?? null)
        : null;

  await prisma.appRuntimeConfig.upsert({
    where: { id: RUNTIME_CONFIG_ID },
    update: {
      gatewayUrl: parsed.gatewayUrl,
      gatewayAuthMode: parsed.gatewayAuthMode,
      gatewayTokenEncrypted,
      gatewayPasswordEncrypted,
      appUrl,
    },
    create: {
      id: RUNTIME_CONFIG_ID,
      gatewayUrl: parsed.gatewayUrl,
      gatewayAuthMode: parsed.gatewayAuthMode,
      gatewayTokenEncrypted,
      gatewayPasswordEncrypted,
      appUrl,
    },
  });

  return getStoredRuntimeConfig();
}

export async function getRuntimeAppUrl() {
  const config = await getResolvedRuntimeConfig();
  return config?.appUrl ?? null;
}

export async function getGatewayRuntimeConfigOrThrow() {
  const config = await getResolvedRuntimeConfig();
  if (!config || !config.gatewayCredentialConfigured) {
    throw new Error("Gateway runtime config is not initialized");
  }

  return {
    gatewayUrl: config.gatewayUrl,
    gatewayAuthMode: config.gatewayAuthMode,
    gatewayToken: config.gatewayToken,
    gatewayPassword: config.gatewayPassword,
  };
}
