import { LanguageSwitcher } from "@/components/language-switcher";
import { connection } from "next/server";
import { SystemSetupPanel } from "@/components/system-setup-panel";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { redirectAwayFromSetupWhenComplete, getSetupStatus, localizeSetupStatus } from "@/lib/setup";

export async function SetupPage({ locale }: { locale: Locale }) {
  await connection();
  await redirectAwayFromSetupWhenComplete(locale);
  const [messages, status, user] = await Promise.all([
    getDictionary(locale),
    getSetupStatus(),
    getCurrentUser(),
  ]);
  const localizedStatus = localizeSetupStatus(status, messages);

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-6">
      <header className="mb-5 flex items-center justify-end sm:mb-6">
        <LanguageSwitcher locale={locale} messages={messages} />
      </header>
      <SystemSetupPanel locale={locale} messages={messages} initialStatus={localizedStatus} mode={user ? "admin" : "setup"} />
    </main>
  );
}
