import { NextResponse } from "next/server";
import { MessageRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { composePrompt, sendToOpenClaw } from "@/lib/openclaw/chat";
import { prisma } from "@/lib/prisma";
import {
  addCachedMessage,
  getChatSessionForUser,
  touchSession,
} from "@/lib/session-service";

export const runtime = "nodejs";

const schema = z.object({
  message: z.string().min(1),
  attachmentIds: z.array(z.string()).default([]),
});

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
    messages: session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
    attachments: session.attachments.map((attachment) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      mime: attachment.mime,
      size: attachment.size,
    })),
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

  const attachmentRecords = payload.data.attachmentIds.length
    ? await prisma.attachment.findMany({
        where: {
          id: { in: payload.data.attachmentIds },
          userId: user.id,
        },
      })
    : [];

  const prompt = composePrompt(
    payload.data.message,
    attachmentRecords.map((attachment) => attachment.hostPath),
  );
  const encoder = new TextEncoder();

  if (attachmentRecords.length) {
    await prisma.attachment.updateMany({
      where: {
        id: { in: attachmentRecords.map((attachment) => attachment.id) },
      },
      data: {
        sessionId: session.id,
      },
    });
  }

  await addCachedMessage({
    sessionId: session.id,
    role: MessageRole.USER,
    content: payload.data.message,
    attachmentIds: attachmentRecords.map((attachment) => attachment.id),
  });

  await touchSession(
    session.id,
    session.messages.length === 0 ? payload.data.message : undefined,
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
          message: prompt,
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
          messages: updated.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt.toISOString(),
          })),
        });
      } catch (error) {
        console.error("[api/messages] sendToOpenClaw failed", {
          sessionId: session.id,
          agentId: session.agentId,
          openclawSessionId: session.openclawSessionId,
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
        sendEvent({
          type: "error",
          error: error instanceof Error ? error.message : "Failed to send",
        });
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
