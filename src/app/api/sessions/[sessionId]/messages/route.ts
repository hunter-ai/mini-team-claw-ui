import { NextResponse } from "next/server";
import { MessageRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { toChatMessageViews } from "@/lib/chat-presenter";
import { buildOpenClawInput, sendToOpenClaw } from "@/lib/openclaw/chat";
import { OpenClawGatewayError } from "@/lib/openclaw/gateway";
import { prisma } from "@/lib/prisma";
import {
  addCachedMessage,
  getChatSessionForUser,
  touchSession,
} from "@/lib/session-service";

export const runtime = "nodejs";

const schema = z.object({
  message: z.string().default(""),
  attachmentIds: z.array(z.string()).default([]),
});

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
    session: {
      id: session.id,
      title: session.title,
    },
    messages: toChatMessageViews(session.messages, session.attachments),
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

  console.log("[api/messages] request", {
    sessionId: session.id,
    agentId: session.agentId,
    openclawSessionId: session.openclawSessionId,
    userId: user.id,
  });

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

  const input = buildOpenClawInput({
    text: messageText,
    attachments: orderedAttachmentRecords.map((attachment) => ({
      id: attachment.id,
      hostPath: attachment.hostPath,
    })),
  });
  const encoder = new TextEncoder();

  const userMessage = await addCachedMessage({
    sessionId: session.id,
    role: MessageRole.USER,
    content: messageText,
    attachmentIds: orderedAttachmentRecords.map((attachment) => attachment.id),
  });

  console.log("[api/messages] prepared user message", {
    sessionId: session.id,
    userMessageId: userMessage.id,
    attachmentIds: input.attachmentIds,
    attachmentCount: input.attachmentIds.length,
    sendMode: input.mode,
  });

  await touchSession(
    session.id,
    session.messages.length === 0
      ? buildTitleSource(
          messageText,
          orderedAttachmentRecords.map((attachment) => attachment.originalName),
        )
      : undefined,
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendEvent = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await sendToOpenClaw({
          agentId: session.agentId,
          openclawSessionId: session.openclawSessionId,
          message: input.message,
          onDelta: (delta) => {
            sendEvent({ type: "delta", delta });
          },
        });

        const finalContent = result.content || "OpenClaw completed without returning text.";
        const assistantMessage = await addCachedMessage({
          sessionId: session.id,
          role: MessageRole.ASSISTANT,
          content: finalContent,
        });

        await touchSession(session.id);

        const updated = await getChatSessionForUser(user.id, session.id);
        if (!updated) {
          throw new Error("Session refresh failed");
        }

        sendEvent({
          type: "done",
          session: {
            id: updated.id,
            title: updated.title,
            updatedAt: updated.updatedAt.toISOString(),
            lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
          },
          assistantMessage: {
            id: assistantMessage.id,
            role: assistantMessage.role,
            content: assistantMessage.content,
            createdAt: assistantMessage.createdAt.toISOString(),
          },
          messages: toChatMessageViews(updated.messages, updated.attachments),
        });
      } catch (error) {
        console.error("[api/messages] sendToOpenClaw failed", {
          sessionId: session.id,
          userMessageId: userMessage.id,
          agentId: session.agentId,
          openclawSessionId: session.openclawSessionId,
          userId: user.id,
          attachmentIds: input.attachmentIds,
          attachmentCount: input.attachmentIds.length,
          sendMode: input.mode,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : { message: String(error) },
        });
        if (error instanceof OpenClawGatewayError && error.detailCode === "PAIRING_REQUIRED") {
          sendEvent({
            type: "pairing_required",
            pairing: {
              status: "pairing_required",
              message: error.message,
              deviceId:
                typeof error.details?.deviceId === "string" ? error.details.deviceId : null,
              lastPairedAt: null,
              pendingRequests: error.pairingRequest ? [error.pairingRequest] : [],
            },
          });
          return;
        } else {
          sendEvent({
            type: "error",
            error: error instanceof Error ? error.message : "Failed to send",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
