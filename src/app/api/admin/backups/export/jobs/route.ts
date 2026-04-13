import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { createConversationExportJob } from "@/lib/admin-backup";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { localizeError } from "@/lib/user-facing-errors";

export const runtime = "nodejs";

const schema = z.object({
  kind: z.literal("conversations"),
});

export async function POST(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: messages.adminBackup.invalidBackupKind }, { status: 400 });
  }

  try {
    const job = await createConversationExportJob();
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json(localizeError(messages, error, {
      fallbackCode: "backup_invalid_import",
      includeDiagnostic: true,
    }), { status: 500 });
  }
}
