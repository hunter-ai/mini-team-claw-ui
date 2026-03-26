import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSetupStatus } from "@/lib/setup";

export async function GET() {
  const [status, user] = await Promise.all([getSetupStatus(), getCurrentUser()]);

  return NextResponse.json({
    ...status,
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
