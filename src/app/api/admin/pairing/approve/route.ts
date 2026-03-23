import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { approveGatewayPairingRequest } from "@/lib/openclaw/pairing";

const approveSchema = z.object({
  requestId: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = approveSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    const pairing = await approveGatewayPairingRequest(payload.data.requestId);
    return NextResponse.json({ pairing });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to approve pairing request" },
      { status: 500 },
    );
  }
}
