import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createChatSession, listChatSessions, SESSION_PAGE_SIZE } from "@/lib/session-service";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = Number(searchParams.get("limit") ?? SESSION_PAGE_SIZE);
  const cursor = searchParams.get("cursor");

  const { sessions, pageInfo } = await listChatSessions(user.id, {
    limit: Number.isFinite(limitParam) ? limitParam : SESSION_PAGE_SIZE,
    cursor,
  });

  return NextResponse.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
      lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    })),
    pageInfo,
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
