import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { getSetupStatus } from "@/lib/setup";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const setupStatus = await getSetupStatus();
  if (!setupStatus.isComplete) {
    return NextResponse.json({ error: "Setup is not complete" }, { status: 503 });
  }
  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const user = await authenticate(payload.data.username, payload.data.password);
  if (!user) {
    return NextResponse.json({ error: messages.auth.invalidCredentials }, { status: 401 });
  }

  await createSession(user.id);
  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  });
}
