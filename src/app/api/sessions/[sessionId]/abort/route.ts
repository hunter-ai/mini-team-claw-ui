import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { chatRunManager } from "@/lib/chat-run-manager";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { abortOpenClawSession } from "@/lib/openclaw/chat";
import { getChatSessionForUser } from "@/lib/session-service";

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
  const session = await getChatSessionForUser(user.id, sessionId);

  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }

  try {
    await abortOpenClawSession(session.agentId, session.openclawSessionId);
    if (session.runs[0]) {
      await chatRunManager.markAborted(session.runs[0].id, messages.chat.abortedByUser);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/abort] abortOpenClawSession failed", {
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
    return NextResponse.json({ error: messages.sessions.abortFailed }, { status: 502 });
  }
}
