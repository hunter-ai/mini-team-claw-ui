import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { getSetupStatus, localizeSetupStatus } from "@/lib/setup";

export async function GET(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const [status, user] = await Promise.all([getSetupStatus(), getCurrentUser()]);
  const localizedStatus = localizeSetupStatus(status, messages);

  return NextResponse.json({
    ...localizedStatus,
    currentUser: user
      ? {
          id: user.id,
          username: user.username,
          role: user.role,
          openclawAgentId: user.openclawAgentId,
        }
      : null,
  });
}
