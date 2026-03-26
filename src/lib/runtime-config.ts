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

const runtimeConfigSchema = z.object({
  gatewayUrl: z.string().url().refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
    message: "Gateway URL must use ws:// or wss://",
  }),
  gatewayToken: z.string().optional(),
  appUrl: z.string().url().optional().or(z.literal("")),
});

type RuntimeConfigInput = z.input<typeof runtimeConfigSchema>;

type RuntimeConfigRecord = {
  gatewayUrl: string;
  gatewayToken: string;
  gatewayTokenConfigured: boolean;
  appUrl: string | null;
  source: "db" | "env-fallback";
};

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
  options?: { requireGatewayToken?: boolean },
) {
  const parsed = runtimeConfigSchema.parse(input);
  const gatewayToken = parsed.gatewayToken?.trim() ?? "";

  if (options?.requireGatewayToken && !gatewayToken) {
    throw new Error("Gateway token is required");
  }

  return {
    ...parsed,
    gatewayToken,
  };
}

export async function getStoredRuntimeConfig() {
  const record = await prisma.appRuntimeConfig.findUnique({
    where: { id: RUNTIME_CONFIG_ID },
  });

  if (!record) {
    return null;
  }

  return {
    gatewayUrl: record.gatewayUrl,
    gatewayToken: record.gatewayTokenEncrypted ? decrypt(record.gatewayTokenEncrypted) : "",
    gatewayTokenConfigured: Boolean(record.gatewayTokenEncrypted),
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

  return {
    gatewayUrl: env.OPENCLAW_GATEWAY_URL,
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? "",
    gatewayTokenConfigured: Boolean(env.OPENCLAW_GATEWAY_TOKEN?.trim()),
    appUrl: normalizeOptionalString(env.APP_URL),
    source: "env-fallback",
  };
}

export async function saveRuntimeConfig(
  input: RuntimeConfigInput,
  options?: { preserveGatewayToken?: boolean },
) {
  const parsed = validateRuntimeConfig(input, {
    requireGatewayToken: !options?.preserveGatewayToken,
  });
  const gatewayToken = parsed.gatewayToken;
  const appUrl = normalizeOptionalString(parsed.appUrl);
  const existing = options?.preserveGatewayToken
    ? await prisma.appRuntimeConfig.findUnique({
        where: { id: RUNTIME_CONFIG_ID },
        select: { gatewayTokenEncrypted: true },
      })
    : null;
  const gatewayTokenEncrypted =
    options?.preserveGatewayToken && !gatewayToken
      ? (existing?.gatewayTokenEncrypted ?? null)
      : encrypt(gatewayToken);

  await prisma.appRuntimeConfig.upsert({
    where: { id: RUNTIME_CONFIG_ID },
    update: {
      gatewayUrl: parsed.gatewayUrl,
      gatewayTokenEncrypted,
      appUrl,
    },
    create: {
      id: RUNTIME_CONFIG_ID,
      gatewayUrl: parsed.gatewayUrl,
      gatewayTokenEncrypted,
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
  if (!config || !config.gatewayTokenConfigured) {
    throw new Error("Gateway runtime config is not initialized");
  }

  return {
    gatewayUrl: config.gatewayUrl,
    gatewayToken: config.gatewayToken,
  };
}
