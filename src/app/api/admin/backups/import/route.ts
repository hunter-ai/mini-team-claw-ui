import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { importBackupFiles } from "@/lib/admin-backup";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const formData = await request.formData();
  const uploads = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File);
  const fallbackFile = formData.get("file");
  if (uploads.length === 0 && fallbackFile instanceof File) {
    uploads.push(fallbackFile);
  }

  if (uploads.length === 0) {
    return NextResponse.json({ error: messages.adminBackup.fileRequired }, { status: 400 });
  }

  try {
    const files = await Promise.all(
      uploads.map(async (file) => ({
        name: file.name,
        text: await file.text(),
      })),
    );
    const summary = await importBackupFiles(files);
    return NextResponse.json({ summary });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : messages.adminBackup.importFailed,
      },
      { status: 400 },
    );
  }
}
