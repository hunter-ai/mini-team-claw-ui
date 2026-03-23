import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  openclawAgentId: z.string().min(1).optional(),
  password: z.string().min(8).optional(),
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).optional(),
  isActive: z.boolean().optional(),
});

const userSelect = {
  id: true,
  username: true,
  role: true,
  openclawAgentId: true,
  isActive: true,
} as const;

async function countActiveAdmins() {
  return prisma.user.count({
    where: {
      role: UserRole.ADMIN,
      isActive: true,
    },
  });
}

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

  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isActive: true,
    },
  });

  if (!existingUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const nextRole = payload.data.role ?? existingUser.role;
  const nextIsActive = payload.data.isActive ?? existingUser.isActive;

  if (existingUser.role === UserRole.ADMIN && existingUser.isActive && (!nextIsActive || nextRole !== UserRole.ADMIN)) {
    const activeAdminCount = await countActiveAdmins();
    if (activeAdminCount <= 1) {
      return NextResponse.json(
        { error: "At least one active admin must remain." },
        { status: 409 },
      );
    }
  }

  const updateData: {
    openclawAgentId?: string;
    passwordHash?: string;
    role?: UserRole;
    isActive?: boolean;
  } = {
    openclawAgentId: payload.data.openclawAgentId,
    role: payload.data.role,
    isActive: payload.data.isActive,
  };

  if (payload.data.password) {
    updateData.passwordHash = await hash(payload.data.password);
  }

  const updatedUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: updateData,
      select: userSelect,
    });

    if (payload.data.password) {
      await tx.userSession.deleteMany({
        where: { userId },
      });
    }

    return user;
  });

  return NextResponse.json({ user: updatedUser });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await params;
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      isActive: true,
    },
  });

  if (!existingUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (existingUser.isActive) {
    return NextResponse.json(
      { error: "Only disabled users can be deleted." },
      { status: 409 },
    );
  }

  if (existingUser.role === UserRole.ADMIN) {
    const activeAdminCount = await countActiveAdmins();
    if (activeAdminCount <= 1) {
      return NextResponse.json(
        { error: "At least one active admin must remain." },
        { status: 409 },
      );
    }
  }

  await prisma.user.delete({
    where: { id: userId },
  });

  return NextResponse.json({ success: true });
}
