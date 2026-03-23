import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toChatMessageViews } from "@/lib/chat-presenter";
import { serializeActiveRun, serializeSessionSummary } from "@/lib/chat-response";
import { chatRunManager } from "@/lib/chat-run-manager";
import {
  ActiveChatRunConflictError,
  createChatRunForMessage,
  getChatRunByClientRequestId,
} from "@/lib/chat-run-service";
import { prisma } from "@/lib/prisma";
import { getChatSessionForUser } from "@/lib/session-service";

export const runtime = "nodejs";

const schema = z.object({
  message: z.string().default(""),
  attachmentIds: z.array(z.string()).default([]),
  clientRequestId: z.string().min(1),
});

function logMessagesRouteDebug(message: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug(message, details);
}

function buildTitleSource(message: string, attachmentNames: string[]) {
  const trimmed = message.trim();
  if (trimmed) {
    return trimmed;
  }

  if (!attachmentNames.length) {
    return undefined;
  }

  return attachmentNames.join(", ");
}

export async function GET(
  _: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  const session = await getChatSessionForUser(user.id, sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({
    session: serializeSessionSummary(session),
    messages: toChatMessageViews(session.messages, session.attachments),
    activeRun: serializeActiveRun(session.runs[0] ?? null),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  const payload = schema.safeParse(await request.json().catch(() => null));

  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const messageText = payload.data.message.trim();
  const attachmentIds = [...new Set(payload.data.attachmentIds)];

  if (!messageText && attachmentIds.length === 0) {
    return NextResponse.json({ error: "Message or attachment is required" }, { status: 400 });
  }

  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const existingRun = await getChatRunByClientRequestId(
    user.id,
    session.id,
    payload.data.clientRequestId,
  );

  if (existingRun) {
    logMessagesRouteDebug("[chat-debug][api/messages] reusing existing run", {
      sessionId: session.id,
      openclawSessionId: session.openclawSessionId,
      userId: user.id,
      runId: existingRun.id,
      clientRequestId: payload.data.clientRequestId,
      status: existingRun.status,
      gatewayRunId: existingRun.gatewayRunId,
      lastEventSeq: existingRun.lastEventSeq,
    });

    return NextResponse.json({
      created: false,
      run: serializeActiveRun(existingRun),
      session: serializeSessionSummary(session),
    });
  }

  const attachmentRecords = attachmentIds.length
    ? await prisma.attachment.findMany({
        where: {
          id: { in: attachmentIds },
          userId: user.id,
          sessionId: session.id,
        },
      })
    : [];

  if (attachmentRecords.length !== attachmentIds.length) {
    return NextResponse.json({ error: "Some attachments are unavailable for this session" }, { status: 400 });
  }

  const attachmentOrder = new Map(attachmentIds.map((attachmentId, index) => [attachmentId, index]));
  const orderedAttachmentRecords = [...attachmentRecords].sort(
    (left, right) => (attachmentOrder.get(left.id) ?? 0) - (attachmentOrder.get(right.id) ?? 0),
  );

  if (attachmentIds.length) {
    const existingAttachmentUsage = await prisma.chatMessageCache.findFirst({
      where: {
        sessionId: session.id,
        attachmentIds: {
          hasSome: attachmentIds,
        },
      },
      select: { id: true },
    });

    if (existingAttachmentUsage) {
      return NextResponse.json({ error: "Some attachments were already sent" }, { status: 409 });
    }
  }

  try {
    logMessagesRouteDebug("[chat-debug][api/messages] creating run", {
      sessionId: session.id,
      openclawSessionId: session.openclawSessionId,
      userId: user.id,
      clientRequestId: payload.data.clientRequestId,
      attachmentIds: orderedAttachmentRecords.map((attachment) => attachment.id),
      messageLength: messageText.length,
      hasAttachments: orderedAttachmentRecords.length > 0,
    });

    const result = await createChatRunForMessage({
      sessionId: session.id,
      userId: user.id,
      titleSource:
        session.messages.length === 0
          ? buildTitleSource(
              messageText,
              orderedAttachmentRecords.map((attachment) => attachment.originalName),
            )
          : undefined,
      message: messageText,
      attachmentIds: orderedAttachmentRecords.map((attachment) => attachment.id),
      clientRequestId: payload.data.clientRequestId,
    });

    if (result.created) {
      logMessagesRouteDebug("[chat-debug][api/messages] created run", {
        sessionId: session.id,
        openclawSessionId: session.openclawSessionId,
        userId: user.id,
        runId: result.run.id,
        clientRequestId: result.run.clientRequestId,
        idempotencyKey: result.run.idempotencyKey,
        status: result.run.status,
      });
      void chatRunManager.startRun(result.run.id);
      logMessagesRouteDebug("[chat-debug][api/messages] dispatched run manager", {
        sessionId: session.id,
        runId: result.run.id,
        clientRequestId: result.run.clientRequestId,
      });
    }

    const updatedSession = await getChatSessionForUser(user.id, session.id);
    if (!updatedSession) {
      return NextResponse.json({ error: "Session refresh failed" }, { status: 500 });
    }

    return NextResponse.json({
      created: result.created,
      run: serializeActiveRun(result.run),
      session: serializeSessionSummary(updatedSession),
    });
  } catch (error) {
    if (error instanceof ActiveChatRunConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("[api/messages] failed to create run", {
      sessionId: session.id,
      userId: user.id,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : { message: String(error) },
    });

    return NextResponse.json({ error: "Failed to start chat run" }, { status: 500 });
  }
}
