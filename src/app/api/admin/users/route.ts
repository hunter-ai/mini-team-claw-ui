import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  openclawAgentId: z.string().min(1),
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).default(UserRole.MEMBER),
});

export async function GET(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return NextResponse.json({ users });
}

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const payload = createSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.auth.invalidPayload }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { username: payload.data.username },
  });

  if (existing) {
    return NextResponse.json({ error: messages.users.usernameExists }, { status: 409 });
  }

  const passwordHash = await hash(payload.data.password);
  const createdUser = await prisma.user.create({
    data: {
      username: payload.data.username,
      passwordHash,
      openclawAgentId: payload.data.openclawAgentId,
      role: payload.data.role,
    },
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return NextResponse.json({ user: createdUser }, { status: 201 });
}
