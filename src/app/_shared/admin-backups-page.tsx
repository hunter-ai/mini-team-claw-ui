import { AdminPageHeader } from "@/components/admin-page-header";
import { AdminBackupPanel } from "@/components/admin-backup-panel";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export async function AdminBackupsPage({ locale }: { locale: Locale }) {
  const messages = await getDictionary(locale);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow={messages.admin.groupData}
        title={messages.admin.backupsPageTitle}
        description={messages.admin.backupsPageDescription}
      />
      <AdminBackupPanel locale={locale} messages={messages} variant="embedded" />
    </div>
  );
}
