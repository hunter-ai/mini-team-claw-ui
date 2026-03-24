import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { approveGatewayPairingRequest } from "@/lib/openclaw/pairing";

const approveSchema = z.object({
  requestId: z.string().min(1),
});

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const payload = approveSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  try {
    const pairing = await approveGatewayPairingRequest(payload.data.requestId);
    return NextResponse.json({ pairing });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : messages.pairing.failedToApproveRequest },
      { status: 500 },
    );
  }
}
