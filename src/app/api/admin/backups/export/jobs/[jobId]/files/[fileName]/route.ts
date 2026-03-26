import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getBackupJobFile } from "@/lib/admin-backup";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string; fileName: string }> },
) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const { jobId, fileName } = await params;

  try {
    const file = await getBackupJobFile(jobId, decodeURIComponent(fileName));
    return new NextResponse(file.content, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : messages.adminBackup.exportFileNotFound },
      { status: 404 },
    );
  }
}
