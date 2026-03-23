import { randomUUID } from "node:crypto";
import { MessageRole, Prisma, SessionStatus, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const SESSION_PAGE_SIZE = 30;

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
  const title = titleSource ? titleSource.slice(0, 60) : undefined;
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      title: title || undefined,
      lastMessageAt: new Date(),
    },
  });
}
