import { ChatRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { composePrompt, sendToOpenClaw } from "@/lib/openclaw/chat";
import { OpenClawGatewayError } from "@/lib/openclaw/gateway";
import {
  appendChatRunDelta,
  completeChatRun,
  isTerminalChatRunStatus,
  markChatRunAborted,
  markChatRunFailed,
  markChatRunPairingRequired,
  markChatRunStreaming,
  type PersistedChatRunEvent,
} from "@/lib/chat-run-service";

type RunSubscriber = (event: PersistedChatRunEvent) => void;

function logChatRunManagerDebug(message: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug(message, details);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDateIso(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function extractPairingPayload(error: OpenClawGatewayError) {
  const details = isObject(error.details) ? error.details : null;
  const pairingRequest = error.pairingRequest;

  return {
    message: error.message,
    deviceId: readString(details?.deviceId) ?? null,
    lastPairedAt: readDateIso(details?.lastPairedAt) ?? null,
    pendingRequests: pairingRequest ? [pairingRequest] : [],
  };
}

class ChatRunManager {
  private inflight = new Map<string, Promise<void>>();
  private subscribers = new Map<string, Set<RunSubscriber>>();

  isProcessing(runId: string) {
    return this.inflight.has(runId);
  }

  subscribe(runId: string, listener: RunSubscriber) {
    const listeners = this.subscribers.get(runId) ?? new Set<RunSubscriber>();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);

    return () => {
      const next = this.subscribers.get(runId);
      next?.delete(listener);
      if (next && next.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  startRun(runId: string) {
    if (this.inflight.has(runId)) {
      logChatRunManagerDebug("[chat-debug][run-manager] run already inflight", {
        runId,
      });
      return this.inflight.get(runId)!;
    }

    logChatRunManagerDebug("[chat-debug][run-manager] scheduling run", {
      runId,
    });

    const task = this.processRun(runId).finally(() => {
      logChatRunManagerDebug("[chat-debug][run-manager] run settled", {
        runId,
      });
      this.inflight.delete(runId);
    });

    this.inflight.set(runId, task);
    return task;
  }

  async markAborted(runId: string, reason = "Aborted by user") {
    const persisted = await markChatRunAborted(runId, reason);
    if (persisted.event) {
      this.publish(persisted.event);
    }
  }

  private publish(event: PersistedChatRunEvent) {
    const listeners = this.subscribers.get(event.runId);
    if (!listeners?.size) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private async processRun(runId: string) {
    const run = await prisma.chatRun.findUnique({
      where: { id: runId },
      include: {
        session: true,
      },
    });

    if (!run || isTerminalChatRunStatus(run.status)) {
      logChatRunManagerDebug("[chat-debug][run-manager] skipping run", {
        runId,
        found: Boolean(run),
        status: run?.status ?? null,
      });
      return;
    }

    logChatRunManagerDebug("[chat-debug][run-manager] processing run", {
      runId: run.id,
      sessionId: run.sessionId,
      openclawSessionId: run.session.openclawSessionId,
      userId: run.userId,
      clientRequestId: run.clientRequestId,
      idempotencyKey: run.idempotencyKey,
      currentStatus: run.status,
      gatewayRunId: run.gatewayRunId,
    });

    if (!run.userMessageId) {
      const persisted = await markChatRunFailed(run.id, "Run is missing its source user message.");
      if (persisted.event) {
        this.publish(persisted.event);
      }
      return;
    }

    const userMessage = await prisma.chatMessageCache.findUnique({
      where: { id: run.userMessageId },
    });

    if (!userMessage) {
      const persisted = await markChatRunFailed(run.id, "Run source message was not found.");
      if (persisted.event) {
        this.publish(persisted.event);
      }
      return;
    }

    const attachments = userMessage.attachmentIds.length
      ? await prisma.attachment.findMany({
          where: {
            id: { in: userMessage.attachmentIds },
            userId: run.userId,
          },
        })
      : [];

    const prompt = composePrompt(
      userMessage.content,
      attachments.map((attachment) => attachment.hostPath),
    );

    let lifecycleError: string | null = null;
    let deltaCount = 0;
    let streamedChars = 0;

    try {
      const result = await sendToOpenClaw({
        agentId: run.session.agentId,
        openclawSessionId: run.session.openclawSessionId,
        message: prompt,
        idempotencyKey: run.idempotencyKey,
        onStarted: async (meta) => {
          logChatRunManagerDebug("[chat-debug][run-manager] gateway acknowledged run", {
            runId: run.id,
            sessionId: run.sessionId,
            clientRequestId: run.clientRequestId,
            gatewayRunId: meta.runId,
            gatewayStatus: meta.status,
          });
          const started = await markChatRunStreaming({
            runId: run.id,
            gatewayRunId: meta.runId,
            gatewayStatus: meta.status,
          });
          if (started.event) {
            logChatRunManagerDebug("[chat-debug][run-manager] persisted started event", {
              runId: run.id,
              sessionId: run.sessionId,
              seq: started.event.seq,
              gatewayRunId: meta.runId,
            });
            this.publish(started.event);
          }
        },
        onDelta: async (delta) => {
          deltaCount += 1;
          streamedChars += delta.length;
          const persisted = await appendChatRunDelta(run.id, delta);
          if (persisted.event) {
            if (deltaCount <= 3 || deltaCount % 50 === 0) {
              logChatRunManagerDebug("[chat-debug][run-manager] persisted delta", {
                runId: run.id,
                sessionId: run.sessionId,
                seq: persisted.event.seq,
                deltaCount,
                streamedChars,
                deltaLength: delta.length,
                deltaPreview: delta.slice(0, 80),
              });
            }
            this.publish(persisted.event);
          }
        },
        onError: async (message) => {
          lifecycleError = message;
          logChatRunManagerDebug("[chat-debug][run-manager] gateway reported lifecycle error", {
            runId: run.id,
            sessionId: run.sessionId,
            clientRequestId: run.clientRequestId,
            error: message,
          });
        },
      });

      logChatRunManagerDebug("[chat-debug][run-manager] gateway completed run", {
        runId: run.id,
        sessionId: run.sessionId,
        clientRequestId: run.clientRequestId,
        gatewayRunId: result.runId,
        gatewayStatus: result.status,
        deltaCount,
        streamedChars,
        finalContentLength: result.content.length,
      });

      const completed = await completeChatRun(run.id, result.content);
      if (completed.event) {
        logChatRunManagerDebug("[chat-debug][run-manager] persisted done event", {
          runId: run.id,
          sessionId: run.sessionId,
          seq: completed.event.seq,
          assistantMessageId: completed.assistantMessageId,
        });
        this.publish(completed.event);
      }
    } catch (error) {
      const latest = await prisma.chatRun.findUnique({
        where: { id: run.id },
      });

      if (!latest || latest.status === ChatRunStatus.ABORTED || latest.status === ChatRunStatus.COMPLETED) {
        logChatRunManagerDebug("[chat-debug][run-manager] ignoring failure because run already terminal", {
          runId: run.id,
          latestStatus: latest?.status ?? null,
        });
        return;
      }

      if (error instanceof OpenClawGatewayError && error.detailCode === "PAIRING_REQUIRED") {
        logChatRunManagerDebug("[chat-debug][run-manager] pairing required", {
          runId: run.id,
          sessionId: run.sessionId,
          clientRequestId: run.clientRequestId,
          error: error.message,
        });
        const pairingRequired = await markChatRunPairingRequired(run.id, extractPairingPayload(error));
        if (pairingRequired.event) {
          this.publish(pairingRequired.event);
        }
        return;
      }

      const message =
        lifecycleError ??
        (error instanceof Error ? error.message : "Failed to stream OpenClaw response");
      logChatRunManagerDebug("[chat-debug][run-manager] failing run", {
        runId: run.id,
        sessionId: run.sessionId,
        clientRequestId: run.clientRequestId,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
              }
            : { message: String(error) },
        lifecycleError,
        deltaCount,
        streamedChars,
      });
      const failed = await markChatRunFailed(run.id, message);
      if (failed.event) {
        logChatRunManagerDebug("[chat-debug][run-manager] persisted failed event", {
          runId: run.id,
          sessionId: run.sessionId,
          seq: failed.event.seq,
          error: message,
        });
        this.publish(failed.event);
      }
    }
  }
}

const globalForChatRunManager = globalThis as typeof globalThis & {
  chatRunManager?: ChatRunManager;
};

export const chatRunManager =
  globalForChatRunManager.chatRunManager ?? new ChatRunManager();

if (process.env.NODE_ENV !== "production") {
  globalForChatRunManager.chatRunManager = chatRunManager;
}
