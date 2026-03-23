import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createChatSession, listChatSessions } from "@/lib/session-service";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sessions = await listChatSessions(user.id);
  return NextResponse.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    })),
  });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = await createChatSession(user);
  return NextResponse.json({
    session: {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    },
  });
}
