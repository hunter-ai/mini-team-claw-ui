import Link from "next/link";
import { AdminUserManager } from "@/components/admin-user-manager";
import { LanguageSwitcher } from "@/components/language-switcher";
import { LogoutButton } from "@/components/logout-button";
import { requireAdminInLocale } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { prisma } from "@/lib/prisma";

export async function AdminPage({ locale }: { locale: Locale }) {
  await requireAdminInLocale(locale);
  const messages = await getDictionary(locale);
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="ui-card mb-6 flex flex-col gap-4 rounded-[2rem] px-5 py-5 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">{messages.admin.eyebrow}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            {messages.admin.title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher locale={locale} messages={messages} />
          <Link
            href={localizeHref(locale, "/chat")}
            className="ui-button-secondary rounded-full px-3 py-2 text-sm font-medium"
          >
            {messages.nav.backToChat}
          </Link>
          <LogoutButton locale={locale} messages={messages} />
        </div>
      </header>
      <AdminUserManager locale={locale} messages={messages} initialUsers={users} />
    </main>
  );
}
