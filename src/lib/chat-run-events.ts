import { Prisma } from "@prisma/client";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { UserFacingErrorCode } from "@/lib/user-facing-errors";
import { errorFromCode, inferErrorCode } from "@/lib/user-facing-errors";

export type ClientAssistantRenderMode = "markdown" | "plain_text";

export type ClientToolEventPayload = {
  key: string;
  callId: string | null;
  name: string;
  status: "started" | "running" | "completed" | "failed";
  summary: string | null;
  outputPreview: string | null;
  raw: Record<string, unknown> | null;
};

export type ClientRunActivityEntry =
  | {
      kind: "tool";
      key: string;
      runId: string;
      seq: number;
      createdAt: string;
      tool: ClientToolEventPayload;
    }
  | {
      kind: "lifecycle";
      key: string;
      runId: string;
      seq: number;
      createdAt: string;
      phase: "started" | "completed" | "failed" | "aborted" | "pairing_required";
      title: string;
      detail: string | null;
      diagnostic: string | null;
    };

export type ClientRunHistoryItem = {
  runId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  assistantRenderMode: ClientAssistantRenderMode;
  status: "STARTING" | "STREAMING" | "COMPLETED" | "FAILED" | "ABORTED";
  draftAssistantContent: string;
  errorMessage: string | null;
  errorDiagnostic: string | null;
  startedAt: string;
  updatedAt: string;
  steps: ClientRunActivityEntry[];
  contentCheckpoints: Array<{
    beforeStepKey: string;
    text: string;
    textLength: number;
    seq: number;
  }>;
};

export type ClientChatRunEvent =
  | {
      runId: string;
      seq: number;
      type: "started";
      status: "STREAMING";
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "delta";
      delta: string;
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "tool";
      tool: ClientToolEventPayload;
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "done";
      content: string;
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "error";
      error: string;
      errorCode: UserFacingErrorCode;
      errorDiagnostic: string | null;
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "aborted";
      reason: string;
      createdAt: string;
    }
  | {
      runId: string;
      seq: number;
      type: "pairing_required";
      pairing: {
        status: "pairing_required";
        message: string;
        diagnostic: string | null;
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
      };
      createdAt: string;
    };

type EventRecord = {
  runId: string;
  seq: number;
  type: string;
  delta: string | null;
  payloadJson: Prisma.JsonValue | null;
  createdAt: Date;
};

function asRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shouldExposeDiagnostic(localized: string | null, diagnostic: string | null) {
  if (!diagnostic) {
    return null;
  }

  return localized?.trim() === diagnostic.trim() ? null : diagnostic;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAssistantRenderMode(value: unknown): ClientAssistantRenderMode {
  return value === "plain_text" ? "plain_text" : "markdown";
}

function readToolPayload(value: Prisma.JsonValue | null): ClientToolEventPayload | null {
  const payload = asRecord(value);
  const tool = asRecord((payload?.tool as Prisma.JsonValue | null) ?? value);
  if (!tool) {
    return null;
  }

  const status = readString(tool.status);
  const normalizedStatus =
    status && ["started", "running", "completed", "failed"].includes(status)
      ? (status as ClientToolEventPayload["status"])
      : "running";

  return {
    key: readNonEmptyString(tool.key) ?? readNonEmptyString(tool.callId) ?? readNonEmptyString(tool.name) ?? "tool",
    callId: readNonEmptyString(tool.callId),
    name: readNonEmptyString(tool.name) ?? "Tool",
    status: normalizedStatus,
    summary: readNonEmptyString(tool.summary),
    outputPreview: readNonEmptyString(tool.outputPreview),
    raw: asRecord((tool.raw as Prisma.JsonValue | null) ?? null),
  };
}

function readContentCheckpoint(
  event: EventRecord,
): {
  beforeStepKey: string;
  text: string;
  textLength: number;
  seq: number;
} | null {
  const payload = asRecord(event.payloadJson);
  const beforeStepKey = readNonEmptyString(payload?.beforeStepKey);
  const text = readString(payload?.text);
  const textLength = readNumber(payload?.textLength);

  if (!beforeStepKey || text === null) {
    return null;
  }

  return {
    beforeStepKey,
    text,
    textLength: textLength ?? text.length,
    seq: event.seq,
  };
}

function serializeLifecycleEntry(
  event: EventRecord,
  payload: Record<string, unknown> | null,
  messages?: Dictionary,
) {
  if (event.type === "started") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      createdAt: event.createdAt.toISOString(),
      phase: "started",
      title: "Run started",
      detail: null,
      diagnostic: null,
    } satisfies ClientRunActivityEntry;
  }

  if (event.type === "done") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      createdAt: event.createdAt.toISOString(),
      phase: "completed",
      title: "Response completed",
      detail: null,
      diagnostic: null,
    } satisfies ClientRunActivityEntry;
  }

  if (event.type === "aborted") {
    const detail = readNonEmptyString(payload?.reason);
    return {
      kind: "lifecycle",
      key: `lifecycle:${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      createdAt: event.createdAt.toISOString(),
      phase: "aborted",
      title: "Run aborted",
      detail,
      diagnostic: null,
    } satisfies ClientRunActivityEntry;
  }

  if (event.type === "pairing_required") {
    const pairing = asRecord(payload?.pairing as Prisma.JsonValue | null);
    const rawDetail = readNonEmptyString(pairing?.message) ?? "Device pairing required";
    const code = inferErrorCode(new Error(rawDetail));
    const detail = messages ? errorFromCode(messages, code).error : rawDetail;
    return {
      kind: "lifecycle",
      key: `lifecycle:${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      createdAt: event.createdAt.toISOString(),
      phase: "pairing_required",
      title: "Pairing required",
      detail,
      diagnostic: shouldExposeDiagnostic(detail, rawDetail),
    } satisfies ClientRunActivityEntry;
  }

  const rawError = readNonEmptyString(payload?.error);
  const errorCode = inferErrorCode(new Error(rawError ?? "Unknown chat run error"));
  const detail = messages ? errorFromCode(messages, errorCode).error : rawError ?? "Unknown chat run error";

  return {
    kind: "lifecycle",
    key: `lifecycle:${event.runId}:${event.seq}`,
    runId: event.runId,
    seq: event.seq,
    createdAt: event.createdAt.toISOString(),
    phase: "failed",
    title: "Run failed",
    detail,
    diagnostic: shouldExposeDiagnostic(detail, rawError),
  } satisfies ClientRunActivityEntry;
}

export function serializeRunActivity(event: EventRecord, messages?: Dictionary): ClientRunActivityEntry | null {
  const payload = asRecord(event.payloadJson);

  if (event.type === "delta" || event.type === "content_checkpoint") {
    return null;
  }

  if (event.type === "tool") {
    const tool = readToolPayload(event.payloadJson);
    if (!tool) {
      return null;
    }

    return {
      kind: "tool",
      key: tool.key || `tool:${event.runId}:${event.seq}`,
      runId: event.runId,
      seq: event.seq,
      createdAt: event.createdAt.toISOString(),
      tool,
    };
  }

  if (["started", "done", "aborted", "pairing_required", "error"].includes(event.type)) {
    return serializeLifecycleEntry(event, payload, messages);
  }

  return null;
}

export function serializeChatRunEvent(event: EventRecord, messages?: Dictionary): ClientChatRunEvent | null {
  const payload = asRecord(event.payloadJson);
  const createdAt = event.createdAt.toISOString();

  if (event.type === "content_checkpoint") {
    return null;
  }

  if (event.type === "started") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "started",
      status: "STREAMING",
      createdAt,
    };
  }

  if (event.type === "delta") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "delta",
      delta: event.delta ?? "",
      createdAt,
    };
  }

  if (event.type === "tool") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "tool",
      tool: readToolPayload(event.payloadJson) ?? {
        key: `tool:${event.runId}:${event.seq}`,
        callId: null,
        name: "Tool",
        status: "running",
        summary: null,
        outputPreview: null,
        raw: null,
      },
      createdAt,
    };
  }

  if (event.type === "done") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "done",
      content: typeof payload?.content === "string" ? payload.content : "",
      createdAt,
    };
  }

  if (event.type === "aborted") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "aborted",
      reason: typeof payload?.reason === "string" ? payload.reason : "Aborted",
      createdAt,
    };
  }

  if (event.type === "pairing_required") {
    const pairing = asRecord(payload?.pairing as Prisma.JsonValue | null);
    const pendingRequests = Array.isArray(pairing?.pendingRequests)
      ? pairing.pendingRequests.map((item) => {
          const request = asRecord(item as Prisma.JsonValue);
          return {
            requestId: typeof request?.requestId === "string" ? request.requestId : null,
            requestedAt: typeof request?.requestedAt === "string" ? request.requestedAt : null,
            scopes: Array.isArray(request?.scopes)
              ? request.scopes.filter((scope): scope is string => typeof scope === "string")
              : [],
            clientId: typeof request?.clientId === "string" ? request.clientId : null,
            clientMode: typeof request?.clientMode === "string" ? request.clientMode : null,
            clientPlatform:
              typeof request?.clientPlatform === "string" ? request.clientPlatform : null,
            message: typeof request?.message === "string" ? request.message : null,
          };
        })
      : [];

    const localizedPairing = messages
      ? errorFromCode(
          messages,
          inferErrorCode(new Error(typeof pairing?.message === "string" ? pairing.message : "PAIRING_REQUIRED")),
        ).error
      : typeof pairing?.message === "string"
        ? pairing.message
        : "Device pairing required";

    return {
      runId: event.runId,
      seq: event.seq,
      type: "pairing_required",
      pairing: {
        status: "pairing_required",
        message: localizedPairing,
        diagnostic: shouldExposeDiagnostic(
          localizedPairing,
          typeof pairing?.message === "string" ? pairing.message : null,
        ),
        deviceId: typeof pairing?.deviceId === "string" ? pairing.deviceId : null,
        lastPairedAt: typeof pairing?.lastPairedAt === "string" ? pairing.lastPairedAt : null,
        pendingRequests,
      },
      createdAt,
    };
  }

  const localizedError = messages
    ? errorFromCode(
        messages,
        inferErrorCode(new Error(typeof payload?.error === "string" ? payload.error : "Unknown chat run error")),
      ).error
    : typeof payload?.error === "string"
      ? payload.error
      : "Unknown chat run error";

  return {
    runId: event.runId,
    seq: event.seq,
    type: "error",
    error: localizedError,
    errorCode:
      typeof payload?.errorCode === "string"
        ? (payload.errorCode as UserFacingErrorCode)
        : inferErrorCode(new Error(typeof payload?.error === "string" ? payload.error : "Unknown chat run error")),
    errorDiagnostic: shouldExposeDiagnostic(
      localizedError,
      typeof payload?.error === "string" ? payload.error : null,
    ),
    createdAt,
  };
}

export function serializeRunHistoryItem(run: {
  id: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  status: "STARTING" | "STREAMING" | "COMPLETED" | "FAILED" | "ABORTED";
  draftAssistantContent: string;
  errorMessage: string | null;
  startedAt: Date;
  updatedAt: Date;
  events: EventRecord[];
}, messages?: Dictionary): ClientRunHistoryItem {
  const doneEvent = [...run.events].reverse().find((event) => event.type === "done");
  const donePayload = asRecord(doneEvent?.payloadJson ?? null);

  return {
    runId: run.id,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    assistantRenderMode: readAssistantRenderMode(donePayload?.renderMode),
    status: run.status,
    draftAssistantContent: run.draftAssistantContent,
    errorMessage: messages && run.errorMessage
      ? errorFromCode(messages, inferErrorCode(new Error(run.errorMessage))).error
      : run.errorMessage,
    errorDiagnostic:
      messages && run.errorMessage
        ? shouldExposeDiagnostic(
            errorFromCode(messages, inferErrorCode(new Error(run.errorMessage))).error,
            run.errorMessage,
          )
        : null,
    startedAt: run.startedAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    steps: run.events
      .map((event) => serializeRunActivity(event, messages))
      .filter((entry): entry is ClientRunActivityEntry => entry !== null),
    contentCheckpoints: run.events
      .map((event) => (event.type === "content_checkpoint" ? readContentCheckpoint(event) : null))
      .filter(
        (checkpoint): checkpoint is NonNullable<ReturnType<typeof readContentCheckpoint>> =>
          checkpoint !== null,
      ),
  };
}
