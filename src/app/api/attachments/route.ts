import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getChatSessionForUser } from "@/lib/session-service";
import { persistUpload } from "@/lib/upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const formData = await request.formData();
  const file = formData.get("file");
  const sessionId = formData.get("sessionId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "File is required" }, { status: 400 });
  }

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const session = await getChatSessionForUser(user.id, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const saved = await persistUpload(user.id, file);
    const attachment = await prisma.attachment.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        originalName: file.name,
        mime: file.type,
        size: file.size,
        sha256: saved.sha256,
        containerPath: saved.containerPath,
        hostPath: saved.hostPath,
      },
    });

    return NextResponse.json({
      attachment: {
        id: attachment.id,
        originalName: attachment.originalName,
        mime: attachment.mime,
        size: attachment.size,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Upload failed",
      },
      { status: 400 },
    );
  }
}
