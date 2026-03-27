import { AdminShellFrame } from "@/components/admin-shell-frame";
import { requireAdminInLocale } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { redirectToSetupIfNeeded } from "@/lib/setup";
import { getAdminNavigation } from "./admin-navigation";

export async function AdminLayout({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  await redirectToSetupIfNeeded(locale);
  const [, messages] = await Promise.all([requireAdminInLocale(locale), getDictionary(locale)]);
  const sections = getAdminNavigation(messages);

  return (
    <AdminShellFrame locale={locale} messages={messages} sections={sections}>
      {children}
    </AdminShellFrame>
  );
}
