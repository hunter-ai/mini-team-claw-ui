import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { prisma } from "@/lib/prisma";
import { normalizeOpenClawAgentId, validatePasswordUpdateInput } from "@/lib/user-form";

function isPatchPayload(value: unknown): value is {
  openclawAgentId?: string;
  password?: string;
  role?: UserRole;
  isActive?: boolean;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.openclawAgentId === undefined || typeof candidate.openclawAgentId === "string") &&
    (candidate.password === undefined || typeof candidate.password === "string") &&
    (candidate.role === undefined ||
      candidate.role === UserRole.ADMIN ||
      candidate.role === UserRole.MEMBER) &&
    (candidate.isActive === undefined || typeof candidate.isActive === "boolean")
  );
}

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
  const messages = await getDictionary(await resolveRequestLocale(request));
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const { userId } = await params;
  const rawPayload = await request.json().catch(() => null);
  if (!isPatchPayload(rawPayload)) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  if (rawPayload.password !== undefined) {
    const passwordPayload = validatePasswordUpdateInput(
      { password: rawPayload.password },
      messages,
    );
    if (!passwordPayload.success) {
      return NextResponse.json(
        { error: passwordPayload.error, fieldErrors: passwordPayload.fieldErrors },
        { status: 400 },
      );
    }
  }

  const payload = {
    openclawAgentId:
      rawPayload.openclawAgentId === undefined
        ? undefined
        : normalizeOpenClawAgentId(rawPayload.openclawAgentId),
    password: rawPayload.password,
    role: rawPayload.role,
    isActive: rawPayload.isActive,
  };

  if (rawPayload.openclawAgentId !== undefined && !payload.openclawAgentId) {
    return NextResponse.json(
      {
        error: messages.users.agentIdRequired,
        fieldErrors: { openclawAgentId: messages.users.agentIdRequired },
      },
      { status: 400 },
    );
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
    return NextResponse.json({ error: messages.users.userNotFound }, { status: 404 });
  }

  const nextRole = payload.role ?? existingUser.role;
  const nextIsActive = payload.isActive ?? existingUser.isActive;

  if (existingUser.role === UserRole.ADMIN && existingUser.isActive && (!nextIsActive || nextRole !== UserRole.ADMIN)) {
    const activeAdminCount = await countActiveAdmins();
    if (activeAdminCount <= 1) {
      return NextResponse.json(
        { error: messages.users.activeAdminMustRemain },
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
    openclawAgentId: payload.openclawAgentId,
    role: payload.role,
    isActive: payload.isActive,
  };

  if (payload.password) {
    updateData.passwordHash = await hash(payload.password);
  }

  const updatedUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: updateData,
      select: userSelect,
    });

    if (payload.password) {
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
  const messages = await getDictionary(await resolveRequestLocale(_request));
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
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
    return NextResponse.json({ error: messages.users.userNotFound }, { status: 404 });
  }

  if (existingUser.isActive) {
    return NextResponse.json(
      { error: messages.users.onlyDisabledCanBeDeleted },
      { status: 409 },
    );
  }

  if (existingUser.role === UserRole.ADMIN) {
    const activeAdminCount = await countActiveAdmins();
    if (activeAdminCount <= 1) {
      return NextResponse.json(
        { error: messages.users.activeAdminMustRemain },
        { status: 409 },
      );
    }
  }

  await prisma.user.delete({
    where: { id: userId },
  });

  return NextResponse.json({ success: true });
}
