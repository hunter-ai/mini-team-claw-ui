import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { serializeSessionSummary } from "@/lib/chat-response";
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
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = patchSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const title = normalizeSessionTitle(payload.data.title);
  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const { sessionId } = await params;
  const result = await renameChatSessionForUser(user.id, sessionId, title);
  if (result.count === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session refresh failed" }, { status: 500 });
  }

  return NextResponse.json({
    session: serializeSessionSummary(session),
  });
}
