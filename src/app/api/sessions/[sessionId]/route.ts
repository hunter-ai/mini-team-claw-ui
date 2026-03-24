import { NextResponse } from "next/server";
import { SessionStatus } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { serializeSessionSummary } from "@/lib/chat-response";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import {
  getChatSessionForUser,
  normalizeSessionTitle,
  renameChatSessionForUser,
} from "@/lib/session-service";

export const runtime = "nodejs";

const patchSchema = z.object({
  title: z.string(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const payload = patchSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const title = normalizeSessionTitle(payload.data.title);
  if (!title) {
    return NextResponse.json({ error: messages.sessions.titleRequired }, { status: 400 });
  }

  const { sessionId } = await params;
  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }
  if (session.status === SessionStatus.ARCHIVED) {
    return NextResponse.json({ error: messages.sessions.sessionArchived }, { status: 409 });
  }

  const result = await renameChatSessionForUser(user.id, sessionId, title);
  if (result.count === 0) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }

  const updatedSession = await getChatSessionForUser(user.id, sessionId);
  if (!updatedSession) {
    return NextResponse.json({ error: messages.sessions.sessionRefreshFailed }, { status: 500 });
  }

  return NextResponse.json({
    session: serializeSessionSummary(updatedSession),
  });
}
