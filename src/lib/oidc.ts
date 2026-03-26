import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { type User } from "@prisma/client";
import { getStartupEnv } from "@/lib/env";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";
import { prisma } from "@/lib/prisma";

const OIDC_PROVIDER = "oidc";
const OIDC_COOKIE_PREFIX = "mtc_oidc";
const OIDC_FLOW_MAX_AGE_SECONDS = 10 * 60;

const OIDC_STATE_COOKIE = `${OIDC_COOKIE_PREFIX}_state`;
const OIDC_NONCE_COOKIE = `${OIDC_COOKIE_PREFIX}_nonce`;
const OIDC_VERIFIER_COOKIE = `${OIDC_COOKIE_PREFIX}_verifier`;
const OIDC_LOCALE_COOKIE = `${OIDC_COOKIE_PREFIX}_locale`;
const OIDC_PENDING_BIND_COOKIE = `${OIDC_COOKIE_PREFIX}_pending_bind`;

type OidcConfiguration = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  appUrl: string;
  redirectUri: string;
};

type OidcDiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type OidcFlowState = {
  state: string;
  nonce: string;
  codeVerifier: string;
};

type OidcTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
};

type OidcClaims = JWTPayload & {
  sub: string;
  email?: string;
  preferred_username?: string;
};

type PendingOidcBinding = {
  issuer: string;
  subject: string;
  email?: string;
  preferredUsername?: string;
};

let cachedDiscoveryDocument: Promise<OidcDiscoveryDocument> | null = null;
let cachedJwks:
  | {
      issuer: string;
      set: ReturnType<typeof createRemoteJWKSet>;
    }
  | null = null;

function base64UrlEncode(buffer: Buffer) {
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url");
}

function randomUrlSafeString(size = 32) {
  return base64UrlEncode(randomBytes(size));
}

function codeChallengeForVerifier(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oidcCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || undefined;
}

function normalizeNullableString(value: string | null | undefined) {
  return normalizeOptionalString(value) ?? null;
}

function encryptionKey() {
  return createHash("sha256").update(`oidc:${getStartupEnv().SESSION_SECRET}`).digest();
}

function encryptPendingBinding(payload: PendingOidcBinding) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
}

function decryptPendingBinding(value: string) {
  const [ivPart, tagPart, cipherPart] = value.split(".");
  if (!ivPart || !tagPart || !cipherPart) {
    throw new Error("Corrupted OIDC pending binding payload");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), base64UrlDecode(ivPart));
  decipher.setAuthTag(base64UrlDecode(tagPart));
  const plaintext = Buffer.concat([decipher.update(base64UrlDecode(cipherPart)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as PendingOidcBinding;
}

export function getOidcConfig() {
  const env = getStartupEnv();
  const raw = {
    issuer: normalizeOptionalString(env.OIDC_ISSUER),
    clientId: normalizeOptionalString(env.OIDC_CLIENT_ID),
    clientSecret: normalizeOptionalString(env.OIDC_CLIENT_SECRET),
    scopes: normalizeOptionalString(env.OIDC_SCOPES) ?? "openid profile",
    appUrl: normalizeOptionalString(env.APP_URL),
  };

  const hasAnyValue = Boolean(raw.issuer || raw.clientId || raw.clientSecret);
  if (!hasAnyValue) {
    return null;
  }

  if (!raw.issuer || !raw.clientId || !raw.clientSecret || !raw.appUrl) {
    throw new Error("OIDC is partially configured. OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and APP_URL are required.");
  }

  return {
    issuer: raw.issuer,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    scopes: raw.scopes,
    appUrl: raw.appUrl,
    redirectUri: new URL("/api/auth/oidc/callback", raw.appUrl).toString(),
  } satisfies OidcConfiguration;
}

export function isOidcEnabled() {
  try {
    return Boolean(getOidcConfig());
  } catch {
    return false;
  }
}

export async function getOidcDiscoveryDocument() {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }

  if (!cachedDiscoveryDocument) {
    const discoveryUrl = new URL(
      `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );
    cachedDiscoveryDocument = fetch(discoveryUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch OIDC discovery document: ${response.status}`);
      }

      const payload = (await response.json()) as Partial<OidcDiscoveryDocument>;
      if (!payload.authorization_endpoint || !payload.token_endpoint || !payload.jwks_uri) {
        throw new Error("OIDC discovery document is missing required endpoints");
      }

      return {
        authorization_endpoint: payload.authorization_endpoint,
        token_endpoint: payload.token_endpoint,
        jwks_uri: payload.jwks_uri,
      };
    });
  }

  return cachedDiscoveryDocument;
}

async function getOidcJwks() {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }

  const discovery = await getOidcDiscoveryDocument();
  if (!cachedJwks || cachedJwks.issuer !== config.issuer) {
    cachedJwks = {
      issuer: config.issuer,
      set: createRemoteJWKSet(new URL(discovery.jwks_uri)),
    };
  }

  return cachedJwks.set;
}

export async function createOidcAuthorizationUrl(locale: Locale) {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }

  const discovery = await getOidcDiscoveryDocument();
  const flowState: OidcFlowState = {
    state: randomUrlSafeString(),
    nonce: randomUrlSafeString(),
    codeVerifier: randomUrlSafeString(48),
  };

  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", config.scopes);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("code_challenge", codeChallengeForVerifier(flowState.codeVerifier));
  authorizationUrl.searchParams.set("state", flowState.state);
  authorizationUrl.searchParams.set("nonce", flowState.nonce);

  const cookieStore = await cookies();
  cookieStore.set(OIDC_STATE_COOKIE, flowState.state, oidcCookieOptions(OIDC_FLOW_MAX_AGE_SECONDS));
  cookieStore.set(OIDC_NONCE_COOKIE, flowState.nonce, oidcCookieOptions(OIDC_FLOW_MAX_AGE_SECONDS));
  cookieStore.set(OIDC_VERIFIER_COOKIE, flowState.codeVerifier, oidcCookieOptions(OIDC_FLOW_MAX_AGE_SECONDS));
  cookieStore.set(OIDC_LOCALE_COOKIE, locale, oidcCookieOptions(OIDC_FLOW_MAX_AGE_SECONDS));

  return authorizationUrl;
}

export async function getOidcCallbackLocale() {
  const cookieStore = await cookies();
  const locale = cookieStore.get(OIDC_LOCALE_COOKIE)?.value;
  return locale === "zh" ? "zh" : "en";
}

export async function clearOidcFlowCookies() {
  const cookieStore = await cookies();

  for (const name of [OIDC_STATE_COOKIE, OIDC_NONCE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_LOCALE_COOKIE]) {
    cookieStore.set(name, "", oidcCookieOptions(0));
  }
}

export function getOidcLoginRedirectUrl(locale: Locale, error?: string) {
  const config = getOidcConfig();
  const redirectUrl = new URL(localizeHref(locale, "/login"), config?.appUrl ?? "http://localhost");
  if (error) {
    redirectUrl.searchParams.set("error", error);
  }

  return redirectUrl.pathname + redirectUrl.search;
}

export function getOidcBindRedirectUrl(locale: Locale, error?: string) {
  const config = getOidcConfig();
  const redirectUrl = new URL(localizeHref(locale, "/login/bind"), config?.appUrl ?? "http://localhost");
  if (error) {
    redirectUrl.searchParams.set("error", error);
  }

  return redirectUrl.pathname + redirectUrl.search;
}

export async function exchangeOidcCode(params: { code: string }) {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }

  const cookieStore = await cookies();
  const verifier = cookieStore.get(OIDC_VERIFIER_COOKIE)?.value;
  if (!verifier) {
    throw new Error("OIDC code verifier is missing");
  }

  const discovery = await getOidcDiscoveryDocument();
  const requestBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: verifier,
  });

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: requestBody.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`OIDC token exchange failed: ${response.status}`);
  }

  const tokenResponse = (await response.json()) as OidcTokenResponse;
  if (!tokenResponse.id_token) {
    throw new Error("OIDC token response did not include an id_token");
  }

  return tokenResponse;
}

export async function verifyOidcCallback(params: { state: string; code: string }) {
  const config = getOidcConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(OIDC_STATE_COOKIE)?.value;
  const expectedNonce = cookieStore.get(OIDC_NONCE_COOKIE)?.value;

  if (!expectedState || params.state !== expectedState) {
    throw new Error("OIDC state validation failed");
  }

  if (!expectedNonce) {
    throw new Error("OIDC nonce is missing");
  }

  const tokenResponse = await exchangeOidcCode({ code: params.code });
  const jwks = await getOidcJwks();
  const verified = await jwtVerify(tokenResponse.id_token!, jwks, {
    issuer: config.issuer,
    audience: config.clientId,
  });

  const claims = verified.payload as OidcClaims;
  if (!claims.sub) {
    throw new Error("OIDC id_token is missing sub");
  }

  if (claims.nonce !== expectedNonce) {
    throw new Error("OIDC nonce validation failed");
  }

  return claims;
}

export async function findUserFromOidcClaims(
  claims: OidcClaims,
): Promise<{ ok: true; user: User } | { ok: false; reason: "not_bound" | "user_disabled" }> {
  const existingIdentity = await prisma.userIdentity.findUnique({
    where: {
      issuer_subject: {
        issuer: claims.iss!,
        subject: claims.sub,
      },
    },
    include: {
      user: true,
    },
  });

  if (existingIdentity) {
    const updatedIdentity = await prisma.userIdentity.update({
      where: { id: existingIdentity.id },
      data: {
        email: normalizeNullableString(claims.email),
        preferredUsername: normalizeNullableString(claims.preferred_username),
      },
      include: {
        user: true,
      },
    });

    if (!updatedIdentity.user.isActive) {
      return { ok: false, reason: "user_disabled" };
    }

    return { ok: true, user: updatedIdentity.user };
  }

  return { ok: false, reason: "not_bound" };
}

export async function setPendingOidcBinding(claims: OidcClaims) {
  const cookieStore = await cookies();
  const payload: PendingOidcBinding = {
    issuer: claims.iss!,
    subject: claims.sub,
    email: normalizeOptionalString(claims.email),
    preferredUsername: normalizeOptionalString(claims.preferred_username),
  };
  cookieStore.set(
    OIDC_PENDING_BIND_COOKIE,
    encryptPendingBinding(payload),
    oidcCookieOptions(OIDC_FLOW_MAX_AGE_SECONDS),
  );
}

export async function getPendingOidcBinding() {
  const cookieStore = await cookies();
  const value = cookieStore.get(OIDC_PENDING_BIND_COOKIE)?.value;
  if (!value) {
    return null;
  }

  try {
    return decryptPendingBinding(value);
  } catch {
    return null;
  }
}

export async function clearPendingOidcBinding() {
  const cookieStore = await cookies();
  cookieStore.set(OIDC_PENDING_BIND_COOKIE, "", oidcCookieOptions(0));
}

export async function bindPendingOidcIdentityToUser(user: User) {
  const pending = await getPendingOidcBinding();
  if (!pending) {
    return { ok: false as const, reason: "pending_binding_missing" as const };
  }

  if (!user.isActive) {
    return { ok: false as const, reason: "user_disabled" as const };
  }

  const conflictingIdentity = await prisma.userIdentity.findUnique({
    where: {
      issuer_subject: {
        issuer: pending.issuer,
        subject: pending.subject,
      },
    },
  });
  if (conflictingIdentity && conflictingIdentity.userId !== user.id) {
    return { ok: false as const, reason: "identity_already_linked" as const };
  }

  const existingUserIssuerLink = await prisma.userIdentity.findFirst({
    where: {
      userId: user.id,
      issuer: pending.issuer,
    },
  });
  if (existingUserIssuerLink && existingUserIssuerLink.subject !== pending.subject) {
    return { ok: false as const, reason: "user_already_linked" as const };
  }

  await prisma.userIdentity.upsert({
    where: {
      issuer_subject: {
        issuer: pending.issuer,
        subject: pending.subject,
      },
    },
    update: {
      userId: user.id,
      provider: OIDC_PROVIDER,
      email: pending.email ?? null,
      preferredUsername: pending.preferredUsername ?? null,
    },
    create: {
      userId: user.id,
      provider: OIDC_PROVIDER,
      issuer: pending.issuer,
      subject: pending.subject,
      email: pending.email ?? null,
      preferredUsername: pending.preferredUsername ?? null,
    },
  });

  return { ok: true as const };
}
