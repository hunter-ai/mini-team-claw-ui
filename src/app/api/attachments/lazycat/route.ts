import { NextResponse } from "next/server";
import { SessionStatus } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { lazycatPickerSubmitDetailSchema } from "@/lib/lazycat-attachments";
import { createLazycatAttachments } from "@/lib/lazycat-attachments-persistence";
import { mapLazycatPickerDetailToAttachments } from "@/lib/lazycat-attachments.server";
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
    const mappedAttachments = mapLazycatPickerDetailToAttachments({
      detail: payload.data.pickerDetail,
    });

    const attachments = await createLazycatAttachments({
      userId: user.id,
      sessionId: session.id,
      attachments: mappedAttachments,
    });

    return NextResponse.json({
      attachments,
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
