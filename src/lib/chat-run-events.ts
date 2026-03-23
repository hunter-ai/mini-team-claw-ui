import { Prisma } from "@prisma/client";

export type ClientChatRunEvent =
  | {
      runId: string;
      seq: number;
      type: "started";
      status: "STREAMING";
    }
  | {
      runId: string;
      seq: number;
      type: "delta";
      delta: string;
    }
  | {
      runId: string;
      seq: number;
      type: "done";
      content: string;
    }
  | {
      runId: string;
      seq: number;
      type: "error";
      error: string;
    }
  | {
      runId: string;
      seq: number;
      type: "aborted";
      reason: string;
    }
  | {
      runId: string;
      seq: number;
      type: "pairing_required";
      pairing: {
        status: "pairing_required";
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
      };
    };

type EventRecord = {
  runId: string;
  seq: number;
  type: string;
  delta: string | null;
  payloadJson: Prisma.JsonValue | null;
};

function asRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function serializeChatRunEvent(event: EventRecord): ClientChatRunEvent {
  const payload = asRecord(event.payloadJson);

  if (event.type === "started") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "started",
      status: "STREAMING",
    };
  }

  if (event.type === "delta") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "delta",
      delta: event.delta ?? "",
    };
  }

  if (event.type === "done") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "done",
      content: typeof payload?.content === "string" ? payload.content : "",
    };
  }

  if (event.type === "aborted") {
    return {
      runId: event.runId,
      seq: event.seq,
      type: "aborted",
      reason: typeof payload?.reason === "string" ? payload.reason : "Aborted",
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

    return {
      runId: event.runId,
      seq: event.seq,
      type: "pairing_required",
      pairing: {
        status: "pairing_required",
        message: typeof pairing?.message === "string" ? pairing.message : "Device pairing required",
        deviceId: typeof pairing?.deviceId === "string" ? pairing.deviceId : null,
        lastPairedAt: typeof pairing?.lastPairedAt === "string" ? pairing.lastPairedAt : null,
        pendingRequests,
      },
    };
  }

  return {
    runId: event.runId,
    seq: event.seq,
    type: "error",
    error: typeof payload?.error === "string" ? payload.error : "Unknown chat run error",
  };
}
