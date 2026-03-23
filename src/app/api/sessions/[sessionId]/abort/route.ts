import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { chatRunManager } from "@/lib/chat-run-manager";
import { abortOpenClawSession } from "@/lib/openclaw/chat";
import { getChatSessionForUser } from "@/lib/session-service";

export async function POST(
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

  try {
    await abortOpenClawSession(session.agentId, session.openclawSessionId);
    if (session.runs[0]) {
      await chatRunManager.markAborted(session.runs[0].id);
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
    return NextResponse.json({ error: "Abort failed" }, { status: 502 });
  }
}
