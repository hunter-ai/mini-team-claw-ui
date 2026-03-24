import { getCurrentUser } from "@/lib/auth";
import { serializeChatRunEvent } from "@/lib/chat-run-events";
import { chatRunManager } from "@/lib/chat-run-manager";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { getChatRunForUser, isTerminalChatRunStatus, listChatRunEventsAfter } from "@/lib/chat-run-service";

export const runtime = "nodejs";

function encodeSse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function logStreamDebug(message: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug(message, details);
}

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ sessionId: string; runId: string }>;
  },
) {
  const messages = await getDictionary(getRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const { sessionId, runId } = await params;
  const run = await getChatRunForUser(user.id, sessionId, runId);
  if (!run) {
    return Response.json({ error: messages.sessions.runNotFound }, { status: 404 });
  }

  const url = new URL(request.url);
  const afterSeqParam = Number(url.searchParams.get("afterSeq") ?? "0");
  const afterSeq = Number.isFinite(afterSeqParam) && afterSeqParam >= 0 ? afterSeqParam : 0;
  const backlog = await listChatRunEventsAfter(run.id, afterSeq);
  logStreamDebug("[chat-debug][stream] opening SSE", {
    sessionId,
    runId: run.id,
    userId: user.id,
    status: run.status,
    afterSeq,
    backlogCount: backlog.length,
    lastEventSeq: run.lastEventSeq,
    gatewayRunId: run.gatewayRunId,
  });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(encodeSse(payload)));
      };
      const sendSerializedEvent = (event: Awaited<ReturnType<typeof listChatRunEventsAfter>>[number]) => {
        const payload = serializeChatRunEvent(event);
        if (payload) {
          send(payload);
        }
      };

      let closed = false;
      let lastSeq = afterSeq;
      let polling = false;
      let emittedEventCount = 0;

      const close = (reason: string) => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(heartbeat);
        clearInterval(pollTimer);
        unsubscribe();
        logStreamDebug("[chat-debug][stream] closing SSE", {
          sessionId,
          runId: run.id,
          reason,
          lastSeq,
          emittedEventCount,
        });
        controller.close();
      };

      // Emit an initial frame immediately so the first EventSource connection is established
      // even when the run has no backlog yet and the first delta hasn't arrived.
      send({ type: "ping", runId: run.id, seq: null });

      for (const event of backlog) {
        lastSeq = event.seq;
        emittedEventCount += 1;
        sendSerializedEvent(event);
      }

      if (backlog.length > 0) {
        logStreamDebug("[chat-debug][stream] replayed backlog", {
          sessionId,
          runId: run.id,
          backlogCount: backlog.length,
          lastSeq,
        });
      }

      const unsubscribe = chatRunManager.subscribe(run.id, (event) => {
        if (closed || event.seq <= lastSeq) {
          return;
        }

        lastSeq = event.seq;
        emittedEventCount += 1;
        if (event.type !== "delta" || emittedEventCount <= 5 || emittedEventCount % 50 === 0) {
          logStreamDebug("[chat-debug][stream] emitted live event", {
            sessionId,
            runId: run.id,
            seq: event.seq,
            type: event.type,
            emittedEventCount,
          });
        }
        sendSerializedEvent(event);
        if (["done", "error", "aborted", "pairing_required"].includes(event.type)) {
          close(`live:${event.type}`);
        }
      });

      const flushFromDatabase = async () => {
        if (closed || polling) {
          return;
        }

        polling = true;

        try {
          const [latestRun, events] = await Promise.all([
            getChatRunForUser(user.id, sessionId, run.id),
            listChatRunEventsAfter(run.id, lastSeq),
          ]);

          if (!latestRun) {
            close("run-missing");
            return;
          }

          let flushedCount = 0;
          for (const event of events) {
            if (closed || event.seq <= lastSeq) {
              continue;
            }

            lastSeq = event.seq;
            emittedEventCount += 1;
            flushedCount += 1;
            sendSerializedEvent(event);
          }

          if (flushedCount > 0) {
            logStreamDebug("[chat-debug][stream] flushed events from database", {
              sessionId,
              runId: run.id,
              flushedCount,
              lastSeq,
              runStatus: latestRun.status,
            });
          }

          if (isTerminalChatRunStatus(latestRun.status) && lastSeq >= latestRun.lastEventSeq) {
            close(`poll:${latestRun.status}`);
          }
        } catch (error) {
          logStreamDebug("[chat-debug][stream] poll failed", {
            sessionId,
            runId: run.id,
            lastSeq,
            error: error instanceof Error ? error.message : String(error),
          });
          send({
            type: "error",
            runId: run.id,
            seq: lastSeq,
            error: error instanceof Error ? error.message : messages.sessions.failedToStartRun,
          });
          close("poll-error");
        } finally {
          polling = false;
        }
      };

      const heartbeat = setInterval(() => {
        if (!closed) {
          send({ type: "ping", runId: run.id, seq: null });
        }
      }, 15000);

      const pollTimer = setInterval(() => {
        void flushFromDatabase();
      }, 500);

      void flushFromDatabase();

      request.signal.addEventListener("abort", () => {
        close("request-abort");
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
