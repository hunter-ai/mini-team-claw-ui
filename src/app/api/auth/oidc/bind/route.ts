import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import {
  bindPendingOidcIdentityToUser,
  clearPendingOidcBinding,
  getPendingOidcBinding,
} from "@/lib/oidc";
import { getSetupStatus } from "@/lib/setup";
import { errorFromCode } from "@/lib/user-facing-errors";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const setupStatus = await getSetupStatus();
  if (!setupStatus.isComplete) {
    return NextResponse.json(errorFromCode(messages, "setup_not_complete"), { status: 503 });
  }

  const pending = await getPendingOidcBinding();
  if (!pending) {
    return NextResponse.json({ error: messages.login.bindExpired }, { status: 409 });
  }

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const user = await authenticate(payload.data.username, payload.data.password);
  if (!user) {
    return NextResponse.json({ error: messages.auth.invalidCredentials }, { status: 401 });
  }

  const result = await bindPendingOidcIdentityToUser(user);
  if (!result.ok) {
    if (result.reason === "user_disabled") {
      return NextResponse.json({ error: messages.login.oidcUserDisabled }, { status: 409 });
    }

    if (result.reason === "identity_already_linked") {
      return NextResponse.json({ error: messages.login.bindIdentityAlreadyLinked }, { status: 409 });
    }

    if (result.reason === "user_already_linked") {
      return NextResponse.json({ error: messages.login.bindUserAlreadyLinked }, { status: 409 });
    }

    return NextResponse.json({ error: messages.login.bindExpired }, { status: 409 });
  }

  await clearPendingOidcBinding();
  await createSession(user.id);

  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  });
}
