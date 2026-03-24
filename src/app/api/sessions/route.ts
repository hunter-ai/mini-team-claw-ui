import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { serializeSessionSummary } from "@/lib/chat-response";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { createChatSession, listChatSessions, SESSION_PAGE_SIZE } from "@/lib/session-service";

export async function GET(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = Number(searchParams.get("limit") ?? SESSION_PAGE_SIZE);
  const cursor = searchParams.get("cursor");

  const { sessions, pageInfo } = await listChatSessions(user.id, {
    limit: Number.isFinite(limitParam) ? limitParam : SESSION_PAGE_SIZE,
    cursor,
  });

  return NextResponse.json({
    sessions: sessions.map(serializeSessionSummary),
    pageInfo,
  });
}

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const session = await createChatSession(user, messages.sessions.defaultTitle);
  return NextResponse.json({
    session: serializeSessionSummary({ ...session, runs: [] }),
  });
}
