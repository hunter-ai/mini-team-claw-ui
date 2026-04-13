import { SessionShareAccessMode } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import {
  getChatSessionForUser,
} from "@/lib/session-service";
import {
  deleteSessionShare,
  getSessionShareForOwner,
  toShareOwnerResponse,
  upsertSessionShare,
} from "@/lib/session-share";
import { localizeError } from "@/lib/user-facing-errors";

export const runtime = "nodejs";

const putSchema = z.object({
  enabled: z.boolean(),
  accessMode: z.nativeEnum(SessionShareAccessMode).optional(),
  password: z.string().optional(),
  refreshSnapshot: z.boolean().optional(),
});

async function requireOwnedSession(request: Request, params: Promise<{ sessionId: string }>) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false as const,
      locale,
      messages,
      response: NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 }),
    };
  }

  const { sessionId } = await params;
  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return {
      ok: false as const,
      locale,
      messages,
      response: NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 }),
    };
  }

  return {
    ok: true as const,
    locale,
    messages,
    user,
    session,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await requireOwnedSession(request, params);
  if (!context.ok) {
    return context.response;
  }

  const share = await getSessionShareForOwner(context.session.id, context.user.id);
  return NextResponse.json({
    share: await toShareOwnerResponse(share, context.locale),
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await requireOwnedSession(request, params);
  if (!context.ok) {
    return context.response;
  }

  const payload = putSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: context.messages.auth.invalidPayload }, { status: 400 });
  }

  if (!payload.data.enabled) {
    await deleteSessionShare(context.session.id, context.user.id);
    return NextResponse.json({
      share: await toShareOwnerResponse(null, context.locale),
    });
  }

  const accessMode = payload.data.accessMode;
  if (!accessMode) {
    return NextResponse.json({ error: context.messages.share.accessModeRequired }, { status: 400 });
  }

  const currentShare = await getSessionShareForOwner(context.session.id, context.user.id);

  try {
    const share = await upsertSessionShare({
      session: context.session,
      accessMode,
      password: payload.data.password,
      currentShare,
    });

    return NextResponse.json({
      share: await toShareOwnerResponse(share, context.locale),
    });
  } catch (error) {
    return NextResponse.json(localizeError(context.messages, error, {
      fallbackCode: "unknown",
    }), { status: 400 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await requireOwnedSession(request, params);
  if (!context.ok) {
    return context.response;
  }

  await deleteSessionShare(context.session.id, context.user.id);
  return NextResponse.json({
    share: await toShareOwnerResponse(null, context.locale),
  });
}
