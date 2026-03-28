import { redirect } from "next/navigation";
import { connection } from "next/server";
import { OidcBindForm } from "@/components/oidc-bind-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { getPendingOidcBinding } from "@/lib/oidc";
import { redirectToSetupIfNeeded } from "@/lib/setup";

function resolveBindErrorMessage(error: string | null | undefined, messages: Awaited<ReturnType<typeof getDictionary>>) {
  switch (error) {
    case "oidc_bind_expired":
      return messages.login.bindExpired;
    default:
      return null;
  }
}

export async function OidcBindPage({
  locale,
  searchParams,
}: {
  locale: Locale;
  searchParams?: Promise<{ error?: string | string[] }>;
}) {
  await connection();
  await redirectToSetupIfNeeded(locale);
  const user = await getCurrentUser();
  if (user) {
    redirect(localizeHref(locale, "/chat"));
  }

  const [messages, pending, query] = await Promise.all([
    getDictionary(locale),
    getPendingOidcBinding(),
    (searchParams ?? Promise.resolve({})) as Promise<{ error?: string | string[] }>,
  ]);

  if (!pending) {
    redirect(localizeHref(locale, "/login?error=oidc_bind_expired"));
  }

  const queryError =
    typeof query.error === "string" ? query.error : Array.isArray(query.error) ? query.error[0] : undefined;
  const bindError = resolveBindErrorMessage(queryError, messages);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-6 sm:px-5 sm:py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.78),transparent_26%),linear-gradient(180deg,rgba(248,250,252,0.86),rgba(243,244,246,0.24))]" />
      <div className="ui-card relative w-full max-w-md rounded-[2rem] p-5 sm:rounded-[2.4rem] sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs uppercase tracking-[0.35em] text-[color:var(--text-tertiary)]">{messages.login.eyebrow}</p>
          <LanguageSwitcher locale={locale} messages={messages} className="shrink-0" />
        </div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)] sm:text-4xl">
          {messages.login.bindTitle}
        </h1>
        <p className="mt-3 text-sm leading-7 text-[color:var(--text-secondary)]">
          {messages.login.bindDescription}
        </p>
        <div className="mt-4 rounded-[1rem] bg-[color:var(--surface-secondary)] px-4 py-3 text-sm leading-6 text-[color:var(--text-secondary)]">
          <p>{messages.login.bindIssuerLabel}: {pending.issuer}</p>
          {pending.preferredUsername ? <p>{messages.login.bindSuggestedUsernameLabel}: {pending.preferredUsername}</p> : null}
          {pending.email ? <p>{messages.login.bindEmailLabel}: {pending.email}</p> : null}
        </div>
        <div className="mt-6 sm:mt-8">
          {bindError ? (
            <p className="mb-4 rounded-[1rem] border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
              {bindError}
            </p>
          ) : null}
          <OidcBindForm locale={locale} messages={messages} suggestedUsername={pending.preferredUsername} />
        </div>
      </div>
    </main>
  );
}
