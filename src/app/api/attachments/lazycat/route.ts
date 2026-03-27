import { NextResponse } from "next/server";
import { AttachmentSource, SessionStatus } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getStartupEnv } from "@/lib/env";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { lazycatPickerSubmitDetailSchema } from "@/lib/lazycat-attachments";
import { mapLazycatPickerDetailToAttachments } from "@/lib/lazycat-attachments.server";
import { prisma } from "@/lib/prisma";
import { getChatSessionForUser } from "@/lib/session-service";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1),
  pickerDetail: lazycatPickerSubmitDetailSchema,
});

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const session = await getChatSessionForUser(user.id, payload.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }
  if (session.status === SessionStatus.ARCHIVED) {
    return NextResponse.json({ error: messages.sessions.sessionArchived }, { status: 409 });
  }

  try {
    const env = getStartupEnv();
    const mappedAttachments = mapLazycatPickerDetailToAttachments({
      detail: payload.data.pickerDetail,
      pathPrefix: env.LAZYCAT_PICKER_PATH_PREFIX,
      hostRoot: env.OPENCLAW_LAZYCAT_HOST_ROOT,
    });

    const attachments = await prisma.$transaction(
      mappedAttachments.map((attachment) =>
        prisma.attachment.create({
          data: {
            userId: user.id,
            sessionId: session.id,
            source: AttachmentSource.LAZYCAT_PATH,
            originalName: attachment.originalName,
            mime: attachment.mime,
            size: attachment.size,
            sourcePath: attachment.sourcePath,
            hostPath: attachment.hostPath,
          },
        }),
      ),
    );

    return NextResponse.json({
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        originalName: attachment.originalName,
        mime: attachment.mime,
        size: attachment.size,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : messages.chat.lazycatEmptySelection,
      },
      { status: 400 },
    );
  }
}
