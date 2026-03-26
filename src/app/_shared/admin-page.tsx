import Link from "next/link";
import { AdminBackupPanel } from "@/components/admin-backup-panel";
import { AdminUserManager } from "@/components/admin-user-manager";
import { SystemSetupPanel } from "@/components/system-setup-panel";
import { LanguageSwitcher } from "@/components/language-switcher";
import { LogoutButton } from "@/components/logout-button";
import { requireAdminInLocale } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { prisma } from "@/lib/prisma";
import { getSetupStatus, redirectToSetupIfNeeded } from "@/lib/setup";

function serializeAdminUser(user: {
  id: string;
  username: string;
  role: "ADMIN" | "MEMBER";
  openclawAgentId: string;
  isActive: boolean;
  identities: Array<{ issuer: string; createdAt: Date }>;
}) {
  const identity = user.identities[0] ?? null;

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    openclawAgentId: user.openclawAgentId,
    isActive: user.isActive,
    oidcBinding: identity
      ? {
          issuer: identity.issuer,
          linkedAt: identity.createdAt.toISOString(),
        }
      : null,
  };
}

export async function AdminPage({ locale }: { locale: Locale }) {
  await redirectToSetupIfNeeded(locale);
  await requireAdminInLocale(locale);
  const [messages, users, setupStatus] = await Promise.all([
    getDictionary(locale),
    prisma.user.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        username: true,
        role: true,
        openclawAgentId: true,
        isActive: true,
        identities: {
          where: { provider: "oidc" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            issuer: true,
            createdAt: true,
          },
        },
      },
    }),
    getSetupStatus(),
  ]);

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
      <AdminUserManager locale={locale} messages={messages} initialUsers={users.map(serializeAdminUser)} />
      <section className="mt-6">
        <AdminBackupPanel locale={locale} messages={messages} />
      </section>
      <section className="mt-6">
        <header className="mb-4 px-1">
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
            {messages.admin.systemTitle}
          </p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.admin.systemDescription}</p>
        </header>
        <SystemSetupPanel locale={locale} messages={messages} initialStatus={setupStatus} mode="admin" />
      </section>
    </main>
  );
}
