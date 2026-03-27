import { AdminPageHeader } from "@/components/admin-page-header";
import { AdminUserManager } from "@/components/admin-user-manager";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getAdminUsers } from "./admin-data";

export async function AdminMembersPage({ locale }: { locale: Locale }) {
  const [messages, users] = await Promise.all([getDictionary(locale), getAdminUsers()]);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow={messages.admin.groupOperations}
        title={messages.admin.membersPageTitle}
        description={messages.admin.membersPageDescription}
      />
      <AdminUserManager locale={locale} messages={messages} initialUsers={users} variant="embedded" />
    </div>
  );
}
