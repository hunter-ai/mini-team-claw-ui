import { NextResponse } from "next/server";
import { z } from "zod";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import {
  clearSessionShareAccessCookie,
  setSessionShareAccessCookie,
  verifySessionSharePassword,
} from "@/lib/session-share";

export const runtime = "nodejs";

const schema = z.object({
  password: z.string().default(""),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const payload = schema.safeParse(await request.json().catch(() => null));

  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const { publicId } = await params;
  const result = await verifySessionSharePassword(publicId, payload.data.password);

  if (!result.ok) {
    await clearSessionShareAccessCookie(publicId);
    const status = result.code === "not_found" ? 404 : result.code === "not_password_protected" ? 409 : 401;
    const error =
      result.code === "not_found"
        ? messages.share.linkNotFound
        : result.code === "not_password_protected"
          ? messages.share.notPasswordProtected
          : messages.share.passwordInvalid;

    return NextResponse.json({ error }, { status });
  }

  await setSessionShareAccessCookie(result.share.publicId, result.share.accessVersion);
  return NextResponse.json({ ok: true });
}
