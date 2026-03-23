import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession } from "@/lib/auth";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const user = await authenticate(payload.data.username, payload.data.password);
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await createSession(user.id);
  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  });
}
