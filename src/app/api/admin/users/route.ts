import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { prisma } from "@/lib/prisma";
import { validateCreateUserInput } from "@/lib/user-form";

function serializeAdminUser(user: {
  id: string;
  username: string;
  role: UserRole;
  openclawAgentId: string;
  isActive: boolean;
  identities: Array<{ issuer: string; createdAt: Date }>;
}) {
  const identity = user.identities[0] ?? null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    openclawAgentId: user.openclawAgentId,
    isActive: user.isActive,
    oidcBinding: identity
      ? {
          issuer: identity.issuer,
          linkedAt: identity.createdAt.toISOString(),
        }
      : null,
  };
}

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
      identities: {
        where: { provider: "oidc" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          issuer: true,
          createdAt: true,
        },
      },
    },
  });

  return NextResponse.json({ users: users.map(serializeAdminUser) });
}

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }
  const rawPayload = await request.json().catch(() => null);
  const payload = validateCreateUserInput(rawPayload, messages, { includeRole: true });
  if (!payload.success) {
    return NextResponse.json(
      { error: payload.error, fieldErrors: payload.fieldErrors },
      { status: 400 },
    );
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
