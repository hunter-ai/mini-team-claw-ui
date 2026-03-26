import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getStartupEnv } from "@/lib/env";

const IDENTITY_ROW_ID = "default";
const ENCRYPTION_CONTEXT = "openclaw-gateway-identity";

type StoredIdentity = {
  deviceId: string;
  publicKey: string;
  privateKeySeed: string;
  deviceToken: string;
  tokenScopes: string[];
  lastPairedAt: Date | null;
  lastPairingStatus: string | null;
  lastPairingMessage: string | null;
  lastPairingRequestId: string | null;
  lastPairingRequestedAt: Date | null;
  lastRequestedScopes: string[];
  lastPairingClientId: string | null;
  lastPairingClientMode: string | null;
  lastPairingClientPlatform: string | null;
};

type SigningParams = {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  nonce: string;
};

type HelloOkAuth = {
  deviceToken?: string;
  scopes?: unknown;
};

type GatewayDeviceIdentity = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
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
    throw new Error("Corrupted gateway operator identity secret");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), base64UrlDecode(ivPart));
  decipher.setAuthTag(base64UrlDecode(tagPart));
  const plaintext = Buffer.concat([
    decipher.update(base64UrlDecode(ciphertextPart)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });

  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    typeof privateJwk.d !== "string"
  ) {
    throw new Error("Failed to generate an Ed25519 gateway operator identity");
  }

  const publicKeyBytes = base64UrlDecode(publicJwk.x);
  const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");

  return {
    deviceId,
    publicKey: publicJwk.x,
    privateKeySeed: privateJwk.d,
  };
}

async function loadOrCreateStoredIdentity(): Promise<StoredIdentity> {
  const existing = await prisma.gatewayOperatorIdentity.findUnique({
    where: { id: IDENTITY_ROW_ID },
  });

  if (existing) {
    return {
      deviceId: existing.deviceId,
      publicKey: existing.publicKey,
      privateKeySeed: decrypt(existing.privateKeyEncrypted),
      deviceToken: existing.deviceTokenEncrypted ? decrypt(existing.deviceTokenEncrypted) : "",
      tokenScopes: existing.tokenScopes,
      lastPairedAt: existing.lastPairedAt,
      lastPairingStatus: existing.lastPairingStatus,
      lastPairingMessage: existing.lastPairingMessage,
      lastPairingRequestId: existing.lastPairingRequestId,
      lastPairingRequestedAt: existing.lastPairingRequestedAt,
      lastRequestedScopes: existing.lastRequestedScopes,
      lastPairingClientId: existing.lastPairingClientId,
      lastPairingClientMode: existing.lastPairingClientMode,
      lastPairingClientPlatform: existing.lastPairingClientPlatform,
    };
  }

  const generated = generateIdentity();
  await prisma.gatewayOperatorIdentity.create({
    data: {
      id: IDENTITY_ROW_ID,
      deviceId: generated.deviceId,
      publicKey: generated.publicKey,
      privateKeyEncrypted: encrypt(generated.privateKeySeed),
      tokenScopes: [],
    },
  });

  return {
    ...generated,
    deviceToken: "",
    tokenScopes: [],
    lastPairedAt: null,
    lastPairingStatus: null,
    lastPairingMessage: null,
    lastPairingRequestId: null,
    lastPairingRequestedAt: null,
    lastRequestedScopes: [],
    lastPairingClientId: null,
    lastPairingClientMode: null,
    lastPairingClientPlatform: null,
  };
}

export async function buildGatewayDeviceIdentity(params: SigningParams): Promise<GatewayDeviceIdentity> {
  const identity = await loadOrCreateStoredIdentity();
  const signedAt = Date.now();
  const scopes = params.scopes.join(",");
  const payload = `v2|${identity.deviceId}|${params.clientId}|${params.clientMode}|${params.role}|${scopes}|${signedAt}|${params.token}|${params.nonce}`;

  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: identity.publicKey,
      d: identity.privateKeySeed,
    },
    format: "jwk",
  });
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey);

  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: base64UrlEncode(signature),
    signedAt,
    nonce: params.nonce,
  };
}

export type PersistGatewayPairingStateInput = {
  status: string | null;
  message?: string | null;
  requestId?: string | null;
  requestedAt?: Date | null;
  requestedScopes?: string[];
  clientId?: string | null;
  clientMode?: string | null;
  clientPlatform?: string | null;
};

export async function getStoredGatewayIdentity() {
  return loadOrCreateStoredIdentity();
}

export async function resolveGatewayAuthToken(sharedToken: string) {
  const identity = await loadOrCreateStoredIdentity();
  if (identity.deviceToken) {
    return {
      auth: { deviceToken: identity.deviceToken },
      tokenForSignature: identity.deviceToken,
    };
  }

  return {
    auth: sharedToken ? { token: sharedToken } : {},
    tokenForSignature: sharedToken,
  };
}

export async function persistGatewayDeviceToken(auth: HelloOkAuth | undefined) {
  const deviceToken = typeof auth?.deviceToken === "string" ? auth.deviceToken.trim() : "";
  if (!deviceToken) {
    return;
  }

  const tokenScopes = Array.isArray(auth?.scopes)
    ? auth.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];

  await prisma.gatewayOperatorIdentity.update({
    where: { id: IDENTITY_ROW_ID },
    data: {
      deviceTokenEncrypted: encrypt(deviceToken),
      tokenScopes,
      lastPairedAt: new Date(),
      lastPairingStatus: "healthy",
      lastPairingMessage: null,
      lastPairingRequestId: null,
      lastPairingRequestedAt: null,
      lastRequestedScopes: [],
      lastPairingClientId: null,
      lastPairingClientMode: null,
      lastPairingClientPlatform: null,
    },
  });
}

export async function persistGatewayPairingState(input: PersistGatewayPairingStateInput) {
  await loadOrCreateStoredIdentity();
  await prisma.gatewayOperatorIdentity.update({
    where: { id: IDENTITY_ROW_ID },
    data: {
      lastPairingStatus: input.status,
      lastPairingMessage: input.message ?? null,
      lastPairingRequestId: input.requestId ?? null,
      lastPairingRequestedAt: input.requestedAt ?? null,
      lastRequestedScopes: input.requestedScopes ?? [],
      lastPairingClientId: input.clientId ?? null,
      lastPairingClientMode: input.clientMode ?? null,
      lastPairingClientPlatform: input.clientPlatform ?? null,
    },
  });
}
