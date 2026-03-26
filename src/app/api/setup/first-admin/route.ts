import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { prisma } from "@/lib/prisma";
import { getSetupStatus } from "@/lib/setup";

const createSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  openclawAgentId: z.string().min(1),
});

export async function POST(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const [setupStatus, currentUser] = await Promise.all([getSetupStatus(), getCurrentUser()]);

  if (setupStatus.hasActiveAdmin) {
    if (!currentUser || currentUser.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
    }

    return NextResponse.json({ error: "An active admin already exists" }, { status: 409 });
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
  const user = await prisma.user.create({
    data: {
      username: payload.data.username,
      passwordHash,
      role: UserRole.ADMIN,
      openclawAgentId: payload.data.openclawAgentId,
      isActive: true,
    },
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return NextResponse.json({ user }, { status: 201 });
}
