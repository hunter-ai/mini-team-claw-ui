import { LoginForm } from "@/components/login-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { redirectToSetupIfNeeded } from "@/lib/setup";
import { redirect } from "next/navigation";

export async function LoginPage({ locale }: { locale: Locale }) {
  await redirectToSetupIfNeeded(locale);
  const user = await getCurrentUser();
  if (user) {
    redirect(localizeHref(locale, "/chat"));
  }

  const messages = await getDictionary(locale);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.78),transparent_26%),linear-gradient(180deg,rgba(248,250,252,0.86),rgba(243,244,246,0.24))]" />
      <div className="ui-card relative w-full max-w-md rounded-[2.4rem] p-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs uppercase tracking-[0.35em] text-[color:var(--text-tertiary)]">{messages.login.eyebrow}</p>
          <LanguageSwitcher locale={locale} messages={messages} />
        </div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
          {messages.login.title}
        </h1>
        <p className="mt-4 text-sm leading-7 text-[color:var(--text-secondary)]">
          {messages.login.description}
        </p>
        <div className="mt-8">
          <LoginForm locale={locale} messages={messages} />
        </div>
      </div>
    </main>
  );
}
