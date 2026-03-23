import { randomUUID } from "node:crypto";
import { ChatRunStatus, MessageRole, Prisma, SessionStatus, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const SESSION_PAGE_SIZE = 30;
export const RUN_HISTORY_LIMIT = 20;
export const ACTIVE_CHAT_RUN_STATUSES = [ChatRunStatus.STARTING, ChatRunStatus.STREAMING] as const;
export const SESSION_TITLE_MAX_LENGTH = 60;

const activeRunInclude = {
  runs: {
    where: {
      status: {
        in: [...ACTIVE_CHAT_RUN_STATUSES],
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: 1,
  },
};

const runHistoryInclude = {
  runs: {
    orderBy: { createdAt: "desc" as const },
    take: RUN_HISTORY_LIMIT,
    include: {
      events: {
        orderBy: { seq: "asc" as const },
      },
    },
  },
};

type SessionCursorPayload = {
  id: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

type ListChatSessionsOptions = {
  limit?: number;
  cursor?: string | null;
};

const sessionOrderBy = [
  { lastMessageAt: { sort: "desc" as const, nulls: "last" as const } },
  { updatedAt: "desc" as const },
  { id: "desc" as const },
];

export function encodeSessionCursor(cursor: SessionCursorPayload) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeSessionCursor(cursor: string) {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SessionCursorPayload;
  if (!parsed.id || !parsed.updatedAt || !("lastMessageAt" in parsed)) {
    throw new Error("Invalid cursor");
  }
  return parsed;
}

function buildSessionCursorWhere(cursor: SessionCursorPayload): Prisma.ChatSessionWhereInput {
  const updatedAt = new Date(cursor.updatedAt);
  const lastMessageAt = cursor.lastMessageAt ? new Date(cursor.lastMessageAt) : null;

  if (Number.isNaN(updatedAt.getTime()) || (cursor.lastMessageAt && Number.isNaN(lastMessageAt!.getTime()))) {
    throw new Error("Invalid cursor");
  }

  if (!lastMessageAt) {
    return {
      lastMessageAt: null,
      OR: [
        { updatedAt: { lt: updatedAt } },
        {
          updatedAt,
          id: { lt: cursor.id },
        },
      ],
    };
  }

  return {
    OR: [
      { lastMessageAt: { lt: lastMessageAt } },
      {
        lastMessageAt,
        updatedAt: { lt: updatedAt },
      },
      {
        lastMessageAt,
        updatedAt,
        id: { lt: cursor.id },
      },
      { lastMessageAt: null },
    ],
  };
}

export async function listChatSessions(userId: string, options: ListChatSessionsOptions = {}) {
  const limit = Math.min(Math.max(options.limit ?? SESSION_PAGE_SIZE, 1), 100);
  const cursorWhere = options.cursor ? buildSessionCursorWhere(decodeSessionCursor(options.cursor)) : null;

  const sessions = await prisma.chatSession.findMany({
    where: {
      userId,
      status: SessionStatus.ACTIVE,
      ...(cursorWhere ? { AND: [cursorWhere] } : {}),
    },
    orderBy: sessionOrderBy,
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: 1,
      },
      ...activeRunInclude,
    },
    take: limit + 1,
  });

  const hasMore = sessions.length > limit;
  const items = hasMore ? sessions.slice(0, limit) : sessions;
  const lastItem = items.at(-1);

  return {
    sessions: items,
    pageInfo: {
      hasMore,
      nextCursor: lastItem
        ? encodeSessionCursor({
            id: lastItem.id,
            updatedAt: lastItem.updatedAt.toISOString(),
            lastMessageAt: lastItem.lastMessageAt?.toISOString() ?? null,
          })
        : null,
    },
  };
}

export async function createChatSession(user: Pick<User, "id" | "openclawAgentId">) {
  return prisma.chatSession.create({
    data: {
      userId: user.id,
      agentId: user.openclawAgentId,
      openclawSessionId: `mtc_${user.id}_${randomUUID()}`,
      title: "New session",
    },
  });
}

export async function getChatSessionForUser(userId: string, sessionId: string) {
  return prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      userId,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
      },
      ...runHistoryInclude,
    },
  });
}

export function normalizeSessionTitle(title: string) {
  return title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
}

export async function renameChatSessionForUser(userId: string, sessionId: string, title: string) {
  return prisma.chatSession.updateMany({
    where: {
      id: sessionId,
      userId,
      status: SessionStatus.ACTIVE,
    },
    data: {
      title: normalizeSessionTitle(title),
      isTitleManuallySet: true,
    },
  });
}

export async function addCachedMessage({
  sessionId,
  role,
  content,
  attachmentIds = [],
}: {
  sessionId: string;
  role: MessageRole;
  content: string;
  attachmentIds?: string[];
}) {
  return prisma.chatMessageCache.create({
    data: {
      sessionId,
      role,
      content,
      attachmentIds,
    },
  });
}

export async function touchSession(sessionId: string, titleSource?: string) {
  const title = titleSource ? normalizeSessionTitle(titleSource) : undefined;
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      title: title || undefined,
      lastMessageAt: new Date(),
    },
  });
}
