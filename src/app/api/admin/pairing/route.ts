import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import {
  getGatewayPairingSummary,
  refreshGatewayPairingSummary,
} from "@/lib/openclaw/pairing";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pairing = await getGatewayPairingSummary();
  return NextResponse.json({ pairing });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pairing = await refreshGatewayPairingSummary();
  return NextResponse.json({ pairing });
}
