import { NextResponse } from "next/server";
import { AttachmentSource, SessionStatus } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { prisma } from "@/lib/prisma";
import { getChatSessionForUser } from "@/lib/session-service";
import { persistUpload } from "@/lib/upload";
import { localizeError } from "@/lib/user-facing-errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const formData = await request.formData();
  const file = formData.get("file");
  const sessionId = formData.get("sessionId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: messages.attachments.fileRequired }, { status: 400 });
  }

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: messages.attachments.sessionIdRequired }, { status: 400 });
  }

  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }
  if (session.status === SessionStatus.ARCHIVED) {
    return NextResponse.json({ error: messages.sessions.sessionArchived }, { status: 409 });
  }

  try {
    const saved = await persistUpload(user.id, session.id, file);
    const attachment = await prisma.attachment.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        source: AttachmentSource.UPLOAD,
        originalName: file.name,
        mime: saved.mime,
        size: file.size,
        sha256: saved.sha256,
        containerPath: saved.containerPath,
        hostPath: saved.hostPath,
      },
    });

    return NextResponse.json({
      attachment: {
        id: attachment.id,
        originalName: attachment.originalName,
        mime: attachment.mime,
        size: attachment.size,
      },
    });
  } catch (error) {
    return NextResponse.json(localizeError(messages, error, {
      fallbackCode: "unknown",
    }), { status: 400 });
  }
}
