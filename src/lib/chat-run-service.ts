import { ChatRunStatus, MessageRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeSessionTitle } from "@/lib/session-service";

export const ACTIVE_CHAT_RUN_STATUSES = [ChatRunStatus.STARTING, ChatRunStatus.STREAMING] as const;
export const TERMINAL_CHAT_RUN_STATUSES = [
  ChatRunStatus.COMPLETED,
  ChatRunStatus.FAILED,
  ChatRunStatus.ABORTED,
] as const;

export function isTerminalChatRunStatus(status: ChatRunStatus) {
  return TERMINAL_CHAT_RUN_STATUSES.some((candidate) => candidate === status);
}

export type ActiveChatRunSnapshot = {
  id: string;
  status: ChatRunStatus;
  clientRequestId: string;
  assistantMessageId: string | null;
  gatewayRunId: string | null;
  lastEventSeq: number;
  draftAssistantContent: string;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
};

export type PersistedChatRunEvent = {
  id: string;
  runId: string;
  seq: number;
  type: string;
  delta: string | null;
  payloadJson: Prisma.JsonValue | null;
  createdAt: Date;
};

export class ActiveChatRunConflictError extends Error {
  constructor(message = "A response is already in progress for this session.") {
    super(message);
    this.name = "ActiveChatRunConflictError";
  }
}

function toJsonValue(
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return Prisma.JsonNull;
  }

  return value as Prisma.InputJsonValue;
}

export function mapActiveChatRun(run: {
  id: string;
  status: ChatRunStatus;
  clientRequestId: string;
  assistantMessageId?: string | null;
  gatewayRunId?: string | null;
  lastEventSeq: number;
  draftAssistantContent: string;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
} | null | undefined): ActiveChatRunSnapshot | null {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    status: run.status,
    clientRequestId: run.clientRequestId,
    assistantMessageId: run.assistantMessageId ?? null,
    gatewayRunId: run.gatewayRunId ?? null,
    lastEventSeq: run.lastEventSeq,
    draftAssistantContent: run.draftAssistantContent,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

export async function getChatRunForUser(userId: string, sessionId: string, runId: string) {
  return prisma.chatRun.findFirst({
    where: {
      id: runId,
      sessionId,
      userId,
    },
  });
}

export async function getChatRunByClientRequestId(
  userId: string,
  sessionId: string,
  clientRequestId: string,
) {
  return prisma.chatRun.findFirst({
    where: {
      userId,
      sessionId,
      clientRequestId,
    },
  });
}

export async function getActiveChatRunForSession(userId: string, sessionId: string) {
  return prisma.chatRun.findFirst({
    where: {
      userId,
      sessionId,
      status: {
        in: [...ACTIVE_CHAT_RUN_STATUSES],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function createChatRunForMessage(args: {
  sessionId: string;
  userId: string;
  titleSource?: string;
  message: string;
  attachmentIds?: string[];
  clientRequestId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const currentSession = await tx.chatSession.findUnique({
      where: { id: args.sessionId },
      select: {
        userId: true,
        isTitleManuallySet: true,
      },
    });

    if (!currentSession || currentSession.userId !== args.userId) {
      throw new Error("Session not found");
    }

    const existing = await tx.chatRun.findFirst({
      where: {
        sessionId: args.sessionId,
        userId: args.userId,
        clientRequestId: args.clientRequestId,
      },
    });

    if (existing) {
      return { run: existing, created: false } as const;
    }

    const activeRun = await tx.chatRun.findFirst({
      where: {
        sessionId: args.sessionId,
        userId: args.userId,
        status: {
          in: [...ACTIVE_CHAT_RUN_STATUSES],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (activeRun) {
      throw new ActiveChatRunConflictError();
    }

    const userMessage = await tx.chatMessageCache.create({
      data: {
        sessionId: args.sessionId,
        role: MessageRole.USER,
        content: args.message,
        attachmentIds: args.attachmentIds ?? [],
      },
    });

    if (args.attachmentIds?.length) {
      await tx.attachment.updateMany({
        where: {
          id: { in: args.attachmentIds },
          userId: args.userId,
        },
        data: {
          sessionId: args.sessionId,
        },
      });
    }

    await tx.chatSession.update({
      where: { id: args.sessionId },
      data: {
        title:
          args.titleSource && !currentSession.isTitleManuallySet
            ? normalizeSessionTitle(args.titleSource)
            : undefined,
        lastMessageAt: new Date(),
      },
    });

    const run = await tx.chatRun.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        clientRequestId: args.clientRequestId,
        userMessageId: userMessage.id,
        idempotencyKey: `chat-run:${args.sessionId}:${args.clientRequestId}`,
      },
    });

    return { run, created: true } as const;
  });
}

export async function listChatRunEventsAfter(runId: string, afterSeq: number) {
  return prisma.chatRunEvent.findMany({
    where: {
      runId,
      seq: {
        gt: afterSeq,
      },
    },
    orderBy: {
      seq: "asc",
    },
  });
}

async function appendChatRunEvent(args: {
  runId: string;
  type: string;
  delta?: string;
  payloadJson?: Record<string, unknown> | null;
  status?: ChatRunStatus;
  errorMessage?: string | null;
  endedAt?: Date | null;
  draftMode?: "append" | "replace" | "keep";
  draftValue?: string;
  assistantMessageId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.chatRun.findUniqueOrThrow({
      where: { id: args.runId },
    });

    if (isTerminalChatRunStatus(run.status)) {
      return {
        run,
        event: null,
      } as const;
    }

    const nextSeq = run.lastEventSeq + 1;
    const nextDraft =
      args.draftMode === "replace"
        ? args.draftValue ?? ""
        : args.draftMode === "append"
          ? `${run.draftAssistantContent}${args.delta ?? ""}`
          : run.draftAssistantContent;

    const event = await tx.chatRunEvent.create({
      data: {
        runId: run.id,
        seq: nextSeq,
        type: args.type,
        delta: args.delta ?? null,
        payloadJson: toJsonValue(args.payloadJson),
      },
    });

    const updatedRun = await tx.chatRun.update({
      where: { id: run.id },
      data: {
        status: args.status ?? run.status,
        lastEventSeq: nextSeq,
        draftAssistantContent: nextDraft,
        errorMessage:
          args.errorMessage === undefined ? run.errorMessage : args.errorMessage,
        endedAt: args.endedAt === undefined ? run.endedAt : args.endedAt,
        assistantMessageId:
          args.assistantMessageId === undefined ? run.assistantMessageId : args.assistantMessageId,
      },
    });

    return {
      run: updatedRun,
      event,
    } as const;
  });
}

export async function markChatRunStreaming(args: {
  runId: string;
  gatewayRunId?: string | null;
  gatewayStatus?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.chatRun.findUniqueOrThrow({
      where: { id: args.runId },
    });

    if (isTerminalChatRunStatus(run.status)) {
      return {
        run,
        event: null,
      } as const;
    }

    const nextSeq = run.lastEventSeq + 1;
    const event = await tx.chatRunEvent.create({
      data: {
        runId: run.id,
        seq: nextSeq,
        type: "started",
        payloadJson: {
          status: ChatRunStatus.STREAMING,
          gatewayRunId: args.gatewayRunId ?? null,
          gatewayStatus: args.gatewayStatus ?? null,
        },
      },
    });

    const updatedRun = await tx.chatRun.update({
      where: { id: run.id },
      data: {
        status: ChatRunStatus.STREAMING,
        lastEventSeq: nextSeq,
        gatewayRunId: args.gatewayRunId ?? run.gatewayRunId,
      },
    });

    return {
      run: updatedRun,
      event,
    } as const;
  });
}

export async function appendChatRunDelta(runId: string, delta: string) {
  return appendChatRunEvent({
    runId,
    type: "delta",
    delta,
    draftMode: "append",
  });
}

export async function markChatRunAborted(runId: string, reason = "Aborted") {
  return appendChatRunEvent({
    runId,
    type: "aborted",
    payloadJson: { reason },
    status: ChatRunStatus.ABORTED,
    errorMessage: reason,
    endedAt: new Date(),
    draftMode: "keep",
  });
}

export async function markChatRunFailed(runId: string, errorMessage: string) {
  return appendChatRunEvent({
    runId,
    type: "error",
    payloadJson: { error: errorMessage },
    status: ChatRunStatus.FAILED,
    errorMessage,
    endedAt: new Date(),
    draftMode: "keep",
  });
}

export async function markChatRunPairingRequired(
  runId: string,
  pairing: {
    message: string;
    deviceId: string | null;
    lastPairedAt: string | null;
    pendingRequests: Array<{
      requestId: string | null;
      requestedAt: string | null;
      scopes: string[];
      clientId: string | null;
      clientMode: string | null;
      clientPlatform: string | null;
      message: string | null;
    }>;
  },
) {
  return appendChatRunEvent({
    runId,
    type: "pairing_required",
    payloadJson: {
      pairing: {
        status: "pairing_required",
        ...pairing,
      },
    },
    status: ChatRunStatus.FAILED,
    errorMessage: pairing.message,
    endedAt: new Date(),
    draftMode: "keep",
  });
}

export async function completeChatRun(runId: string, content: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.chatRun.findUniqueOrThrow({
      where: { id: runId },
      include: {
        session: true,
      },
    });

    if (isTerminalChatRunStatus(run.status)) {
      return {
        run,
        event: null,
        assistantMessageId: run.assistantMessageId,
      } as const;
    }

    const nextSeq = run.lastEventSeq + 1;
    const finalContent = content || run.draftAssistantContent || "OpenClaw completed without returning text.";

    const event = await tx.chatRunEvent.create({
      data: {
        runId: run.id,
        seq: nextSeq,
        type: "done",
        payloadJson: {
          content: finalContent,
        },
      },
    });

    let assistantMessageId = run.assistantMessageId;
    if (!assistantMessageId) {
      const assistantMessage = await tx.chatMessageCache.create({
        data: {
          sessionId: run.sessionId,
          role: MessageRole.ASSISTANT,
          content: finalContent,
          attachmentIds: [],
        },
      });
      assistantMessageId = assistantMessage.id;
    }

    const updatedRun = await tx.chatRun.update({
      where: { id: run.id },
      data: {
        status: ChatRunStatus.COMPLETED,
        lastEventSeq: nextSeq,
        draftAssistantContent: finalContent,
        errorMessage: null,
        endedAt: new Date(),
        assistantMessageId,
      },
    });

    await tx.chatSession.update({
      where: { id: run.sessionId },
      data: {
        lastMessageAt: new Date(),
      },
    });

    return {
      run: updatedRun,
      event,
      assistantMessageId,
    } as const;
  });
}
