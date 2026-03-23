import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  openclawAgentId: z.string().min(1).optional(),
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId } = await params;
  const payload = patchSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: payload.data,
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return NextResponse.json({ user: updatedUser });
}
