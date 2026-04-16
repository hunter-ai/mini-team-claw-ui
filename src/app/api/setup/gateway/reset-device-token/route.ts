import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { checkGatewayConnection } from "@/lib/openclaw/gateway-connection-check";
import { clearGatewayDeviceToken } from "@/lib/openclaw/device-identity";
import { getSetupStatus } from "@/lib/setup";

export async function POST(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const [setupStatus, user] = await Promise.all([getSetupStatus(), getCurrentUser()]);

  if (setupStatus.isComplete && (!user || user.role !== UserRole.ADMIN)) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  await clearGatewayDeviceToken();
  const result = await checkGatewayConnection(messages);

  if (result.status === "healthy") {
    return NextResponse.json({
      ...result,
      message: messages.setup.gatewayDeviceResetSucceeded,
    }, { status: 200 });
  }

  return NextResponse.json(result, { status: 200 });
}
