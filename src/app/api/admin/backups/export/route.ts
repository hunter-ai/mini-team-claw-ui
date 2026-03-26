import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import {
  createBackupFilename,
  exportUsersBackup,
} from "@/lib/admin-backup";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

export const runtime = "nodejs";

const querySchema = z.object({
  kind: z.enum(["users", "conversations"]),
});

export async function GET(request: Request) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user || user.role !== UserRole.ADMIN) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return NextResponse.json({ error: messages.adminBackup.invalidBackupKind }, { status: 400 });
  }

  if (query.data.kind === "conversations") {
    return NextResponse.json(
      { error: messages.adminBackup.conversationExportUsesShards },
      { status: 409 },
    );
  }

  const payload = await exportUsersBackup();
  const filename = createBackupFilename(payload.kind, payload.exportedAt);

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
