import { NextResponse } from "next/server";
import { SessionStatus } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getActiveChatRunForSession } from "@/lib/chat-run-service";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { sendToOpenClaw } from "@/lib/openclaw/chat";
import { prisma } from "@/lib/prisma";
import { parseSessionContextUsage } from "@/lib/session-context-usage";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const { sessionId } = await params;
  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
    select: {
      id: true,
      agentId: true,
      openclawSessionId: true,
      status: true,
    },
  });

  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }

  if (session.status === SessionStatus.ARCHIVED) {
    return NextResponse.json({ status: "unavailable" }, { status: 200 });
  }

  const activeRun = await getActiveChatRunForSession(user.id, session.id);
  if (activeRun) {
    return NextResponse.json({ status: "busy" }, { status: 200 });
  }

  try {
    const result = await sendToOpenClaw({
      agentId: session.agentId,
      openclawSessionId: session.openclawSessionId,
      message: "/context json",
    });

    const usage = parseSessionContextUsage(result.content);
    if (!usage) {
      return NextResponse.json({ status: "unavailable" }, { status: 200 });
    }

    return NextResponse.json({
      status: "ok",
      usage,
    });
  } catch (error) {
    console.error("[api/context] failed to fetch session context usage", {
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

    return NextResponse.json({ status: "unavailable" }, { status: 200 });
  }
}
