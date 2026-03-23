import { NextResponse } from "next/server";
import { hash } from "@node-rs/argon2";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { refreshGatewayPairingSummary } from "@/lib/openclaw/pairing";
import { prisma } from "@/lib/prisma";

const createSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  openclawAgentId: z.string().min(1),
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).default(UserRole.MEMBER),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = createSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { username: payload.data.username },
  });

  if (existing) {
    return NextResponse.json({ error: "Username already exists" }, { status: 409 });
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

  const pairing = await refreshGatewayPairingSummary().catch(() => ({
    status: "failed" as const,
    message: "Member created, but pairing precheck failed.",
    deviceId: "",
    lastPairedAt: null,
    tokenScopes: [],
    pendingRequests: [],
  }));

  return NextResponse.json({ user: createdUser, pairing }, { status: 201 });
}
