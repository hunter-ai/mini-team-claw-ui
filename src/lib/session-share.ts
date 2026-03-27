import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import {
  ChatRunStatus,
  Prisma,
  type Attachment,
  type ChatMessageCache,
  type ChatRun,
  type ChatRunEvent,
  type ChatSession,
  type ChatSessionShare,
  type SessionShareAccessMode,
} from "@prisma/client";
import { cookies } from "next/headers";
import { serializeRunHistoryItem, type ClientRunHistoryItem } from "@/lib/chat-run-events";
import { getRuntimeAppUrl } from "@/lib/runtime-config";
import { getStartupEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { localizeHref } from "@/lib/i18n/routing";
import type { Locale } from "@/lib/i18n/config";
import { toChatMessageViews, type ChatMessageView } from "@/lib/chat-presenter";

export const SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION = 1;
export const SESSION_SHARE_COOKIE_DAYS = 7;
const SESSION_SHARE_COOKIE_NAME_PREFIX = "mtc_share_";
const emptyShareOwnerResponse = {
  enabled: false,
  shareUrl: null,
  accessMode: null,
  snapshotUpdatedAt: null,
} as const;

export type SessionShareSnapshot = {
  schemaVersion: typeof SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION;
  title: string;
  sharedAt: string;
  messages: ChatMessageView[];
  runHistory: ClientRunHistoryItem[];
};

type ShareableSessionRecord = Pick<ChatSession, "id" | "title"> & {
  messages: Pick<
    ChatMessageCache,
    "id" | "role" | "content" | "createdAt" | "attachmentIds" | "selectedSkillsJson"
  >[];
  attachments: Pick<Attachment, "id" | "originalName" | "mime" | "size">[];
  runs: Array<
    Pick<
      ChatRun,
      | "id"
      | "userMessageId"
      | "assistantMessageId"
      | "status"
      | "draftAssistantContent"
      | "errorMessage"
      | "startedAt"
      | "updatedAt"
    > & {
      events: Pick<ChatRunEvent, "id" | "runId" | "seq" | "type" | "delta" | "payloadJson" | "createdAt">[];
    }
  >;
};

function shareCookieName(publicId: string) {
  return `${SESSION_SHARE_COOKIE_NAME_PREFIX}${publicId}`;
}

function signShareCookie(publicId: string, accessVersion: number) {
  return createHmac("sha256", getStartupEnv().SESSION_SECRET)
    .update(`${publicId}:${accessVersion}`)
    .digest("base64url");
}

function sameString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeActiveRunForShare<
  T extends Pick<ChatRun, "status" | "draftAssistantContent" | "errorMessage" | "updatedAt">
>(run: T) {
  if (run.status !== ChatRunStatus.STARTING && run.status !== ChatRunStatus.STREAMING) {
    return run;
  }

  return {
    ...run,
    status: ChatRunStatus.ABORTED,
    errorMessage: run.errorMessage ?? "Shared snapshot captured before this run completed",
    updatedAt: new Date(run.updatedAt),
  };
}

export function buildSessionShareSnapshot(session: ShareableSessionRecord): SessionShareSnapshot {
  return {
    schemaVersion: SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION,
    title: session.title,
    sharedAt: new Date().toISOString(),
    messages: toChatMessageViews(session.messages, session.attachments),
    runHistory: session.runs.map((run) =>
      serializeRunHistoryItem({
        ...normalizeActiveRunForShare(run),
        events: run.events,
      }),
    ),
  };
}

export function createShareAccessCookieValue(publicId: string, accessVersion: number) {
  return `${publicId}.${accessVersion}.${signShareCookie(publicId, accessVersion)}`;
}

export function readShareAccessCookieValue(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const [publicId, rawAccessVersion, signature] = value.split(".");
  if (!publicId || !rawAccessVersion || !signature) {
    return null;
  }

  const accessVersion = Number(rawAccessVersion);
  if (!Number.isInteger(accessVersion) || accessVersion < 1) {
    return null;
  }

  const expectedSignature = signShareCookie(publicId, accessVersion);
  if (!sameString(signature, expectedSignature)) {
    return null;
  }

  return {
    publicId,
    accessVersion,
  };
}

async function shouldUseSecureCookies() {
  const appUrl = await getRuntimeAppUrl();

  if (!appUrl) {
    return process.env.NODE_ENV === "production";
  }

  try {
    return new URL(appUrl).protocol === "https:";
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

export async function setSessionShareAccessCookie(publicId: string, accessVersion: number) {
  const cookieStore = await cookies();
  const expiresAt = new Date(Date.now() + SESSION_SHARE_COOKIE_DAYS * 24 * 60 * 60 * 1000);
  cookieStore.set(shareCookieName(publicId), createShareAccessCookieValue(publicId, accessVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: await shouldUseSecureCookies(),
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionShareAccessCookie(publicId: string) {
  const cookieStore = await cookies();
  cookieStore.set(shareCookieName(publicId), "", {
    httpOnly: true,
    sameSite: "lax",
    secure: await shouldUseSecureCookies(),
    path: "/",
    maxAge: 0,
  });
}

async function hasShareAccessCookie(share: Pick<ChatSessionShare, "publicId" | "accessVersion">) {
  const cookieStore = await cookies();
  const parsed = readShareAccessCookieValue(cookieStore.get(shareCookieName(share.publicId))?.value);
  return Boolean(parsed && parsed.publicId === share.publicId && parsed.accessVersion === share.accessVersion);
}

export async function getSessionShareForOwner(sessionId: string, userId: string) {
  return prisma.chatSessionShare.findFirst({
    where: {
      sessionId,
      userId,
    },
  });
}

export async function getPublicSessionShare(publicId: string) {
  return prisma.chatSessionShare.findUnique({
    where: { publicId },
  });
}

export async function getPublicSessionShareSnapshot(
  publicId: string,
): Promise<
  | {
      share: Pick<ChatSessionShare, "publicId" | "accessMode" | "updatedAt" | "accessVersion">;
      snapshot: SessionShareSnapshot | null;
      requiresPassword: boolean;
    }
  | null
> {
  const share = await getPublicSessionShare(publicId);
  if (!share) {
    return null;
  }

  const requiresPassword = share.accessMode === "PASSWORD" && !(await hasShareAccessCookie(share));
  return {
    share: {
      publicId: share.publicId,
      accessMode: share.accessMode,
      updatedAt: share.updatedAt,
      accessVersion: share.accessVersion,
    },
    snapshot: requiresPassword ? null : (share.snapshotJson as SessionShareSnapshot),
    requiresPassword,
  };
}

function normalizeSharePassword(password: string | null | undefined) {
  const normalized = password?.trim() ?? "";
  return normalized || null;
}

function nextAccessVersion(
  currentShare: Pick<ChatSessionShare, "accessVersion" | "accessMode"> | null,
  accessMode: SessionShareAccessMode,
) {
  if (!currentShare) {
    return 1;
  }

  if (currentShare.accessMode !== accessMode || accessMode === "PASSWORD") {
    return currentShare.accessVersion + 1;
  }

  return currentShare.accessVersion;
}

function createPublicShareId() {
  return randomBytes(18).toString("base64url");
}

export async function upsertSessionShare(args: {
  session: ShareableSessionRecord & Pick<ChatSession, "userId">;
  accessMode: SessionShareAccessMode;
  password?: string | null;
  currentShare?: ChatSessionShare | null;
}) {
  const normalizedPassword = normalizeSharePassword(args.password);
  if (args.accessMode === "PASSWORD" && !normalizedPassword && !args.currentShare?.passwordHash) {
    throw new Error("Password is required");
  }

  const snapshot = buildSessionShareSnapshot(args.session);
  const snapshotJson = JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
  const accessVersion = nextAccessVersion(args.currentShare ?? null, args.accessMode);
  const passwordHash =
    args.accessMode === "PASSWORD"
      ? normalizedPassword
        ? await hash(normalizedPassword)
        : args.currentShare?.passwordHash ?? null
      : null;

  return prisma.chatSessionShare.upsert({
    where: { sessionId: args.session.id },
    create: {
      sessionId: args.session.id,
      userId: args.session.userId,
      publicId: createPublicShareId(),
      accessMode: args.accessMode,
      passwordHash,
      snapshotSchemaVersion: SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION,
      snapshotJson,
      accessVersion,
    },
    update: {
      accessMode: args.accessMode,
      passwordHash,
      snapshotSchemaVersion: SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION,
      snapshotJson,
      accessVersion,
    },
  });
}

export async function deleteSessionShare(sessionId: string, userId: string) {
  return prisma.chatSessionShare.deleteMany({
    where: {
      sessionId,
      userId,
    },
  });
}

export async function verifySessionSharePassword(publicId: string, password: string) {
  const share = await getPublicSessionShare(publicId);
  if (!share) {
    return { ok: false as const, code: "not_found" as const };
  }

  if (share.accessMode !== "PASSWORD" || !share.passwordHash) {
    return { ok: false as const, code: "not_password_protected" as const };
  }

  const normalizedPassword = normalizeSharePassword(password);
  if (!normalizedPassword) {
    return { ok: false as const, code: "invalid_password" as const };
  }

  const valid = await verify(share.passwordHash, normalizedPassword);
  if (!valid) {
    return { ok: false as const, code: "invalid_password" as const };
  }

  return {
    ok: true as const,
    share,
  };
}

export async function buildSessionShareUrl(publicId: string, locale: Locale) {
  const path = localizeHref(locale, `/share/${publicId}`);
  const appUrl = await getRuntimeAppUrl();
  if (!appUrl) {
    return path;
  }

  return new URL(path, appUrl).toString();
}

export function isShareSnapshot(value: unknown): value is SessionShareSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionShareSnapshot>;
  return (
    candidate.schemaVersion === SESSION_SHARE_SNAPSHOT_SCHEMA_VERSION &&
    typeof candidate.title === "string" &&
    typeof candidate.sharedAt === "string" &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.runHistory)
  );
}

export type ShareableSessionForOwner = ShareableSessionRecord & Pick<ChatSession, "userId">;

export async function toShareOwnerResponse(
  share: Pick<ChatSessionShare, "publicId" | "accessMode" | "updatedAt"> | null,
  locale: Locale,
) {
  if (!share) {
    return emptyShareOwnerResponse;
  }

  return {
    enabled: true,
    shareUrl: await buildSessionShareUrl(share.publicId, locale),
    accessMode: share.accessMode,
    snapshotUpdatedAt: share.updatedAt.toISOString(),
  };
}
