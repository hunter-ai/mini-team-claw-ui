import { AdminPageHeader } from "@/components/admin-page-header";
import { SystemSetupPanel } from "@/components/system-setup-panel";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getSetupStatus } from "@/lib/setup";

export async function AdminWorkspacePage({ locale }: { locale: Locale }) {
  const [messages, setupStatus] = await Promise.all([getDictionary(locale), getSetupStatus()]);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow={messages.admin.groupWorkspace}
        title={messages.admin.workspacePageTitle}
        description={messages.admin.workspacePageDescription}
      />
      <SystemSetupPanel locale={locale} messages={messages} initialStatus={setupStatus} mode="admin" />
    </div>
  );
}
