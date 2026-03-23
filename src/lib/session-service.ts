import { randomUUID } from "node:crypto";
import { MessageRole, SessionStatus, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function listChatSessions(userId: string) {
  return prisma.chatSession.findMany({
    where: {
      userId,
      status: SessionStatus.ACTIVE,
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
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
