import { ChatRunStatus, Prisma, SessionStatus } from "@prisma/client";
import { serializeRunHistoryItem } from "@/lib/chat-run-events";
import { toChatMessageViews } from "@/lib/chat-presenter";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { mapActiveChatRun } from "@/lib/chat-run-service";

type SessionLike = {
  id: string;
  title: string;
  status: SessionStatus;
  updatedAt: Date;
  lastMessageAt: Date | null;
  runs?: Array<{
    id: string;
    status: ChatRunStatus;
    clientRequestId: string;
    assistantMessageId?: string | null;
    lastEventSeq: number;
    draftAssistantContent: string;
    errorMessage: string | null;
    startedAt: Date;
    updatedAt: Date;
  }>;
};

type MessageLike = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: Date;
};

type AttachmentLike = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
};

export function serializeSessionSummary(session: SessionLike) {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt.toISOString(),
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    activeRun: serializeActiveRun(session.runs?.[0] ?? null),
  };
}

export function serializeMessage(message: MessageLike) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

export function serializeAttachment(attachment: AttachmentLike) {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mime: attachment.mime,
    size: attachment.size,
  };
}

export function serializeActiveRun(
  run:
    | {
        id: string;
        status: ChatRunStatus;
        clientRequestId: string;
        lastEventSeq: number;
        draftAssistantContent: string;
        errorMessage: string | null;
        startedAt: Date;
        updatedAt: Date;
      }
    | null
    | undefined,
) {
  const snapshot = mapActiveChatRun(run);
  if (!snapshot) {
    return null;
  }

  return {
    id: snapshot.id,
    status: snapshot.status,
    clientRequestId: snapshot.clientRequestId,
    assistantMessageId: snapshot.assistantMessageId,
    lastEventSeq: snapshot.lastEventSeq,
    draftAssistantContent: snapshot.draftAssistantContent,
    errorMessage: snapshot.errorMessage,
    startedAt: snapshot.startedAt.toISOString(),
    updatedAt: snapshot.updatedAt.toISOString(),
  };
}

export function serializeChatSessionDetail(
  session: Omit<SessionLike, "runs"> & {
    messages: Array<{
      id: string;
      role: "USER" | "ASSISTANT" | "SYSTEM";
      content: string;
      createdAt: Date;
      attachmentIds: string[];
      selectedSkillsJson: Prisma.JsonValue;
    }>;
    attachments: AttachmentLike[];
    runs: Array<{
      id: string;
      userMessageId: string | null;
      assistantMessageId: string | null;
      status: ChatRunStatus;
      clientRequestId: string;
      lastEventSeq: number;
      draftAssistantContent: string;
      errorMessage: string | null;
      startedAt: Date;
      updatedAt: Date;
      events: Array<{
        runId: string;
        seq: number;
        type: string;
        delta: string | null;
        payloadJson: Prisma.JsonValue | null;
        createdAt: Date;
      }>;
    }>;
  },
  messages: Dictionary,
) {
  return {
    session: serializeSessionSummary(session),
    messages: toChatMessageViews(session.messages, session.attachments),
    activeRun: serializeActiveRun(session.runs[0] ?? null),
    runHistory: session.runs.map((run) => serializeRunHistoryItem(run, messages)),
  };
}
