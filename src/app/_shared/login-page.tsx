import { LoginForm } from "@/components/login-form";
import { LanguageSwitcher } from "@/components/language-switcher";
import { connection } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getStartupEnv } from "@/lib/env";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary, type Dictionary } from "@/lib/i18n/dictionary";
import { interpolate } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { resolveLoginPrimaryAuthMethod } from "@/lib/login-cta";
import { isOidcEnabled } from "@/lib/oidc";
import { redirectToSetupIfNeeded } from "@/lib/setup";
import { redirect } from "next/navigation";

function resolveLoginErrorMessage(error: string | null | undefined, messages: Dictionary) {
  switch (error) {
    case "oidc_unavailable":
      return messages.login.oidcUnavailable;
    case "oidc_failed":
      return messages.login.oidcFailed;
    case "oidc_user_disabled":
      return messages.login.oidcUserDisabled;
    case "oidc_bind_expired":
      return messages.login.bindExpired;
    default:
      return null;
  }
}

function resolveOidcButtonLabel(messages: Dictionary) {
  const brandName = getStartupEnv().OIDC_BRAND_NAME?.trim();
  if (!brandName) {
    return messages.login.signInWithSso;
  }

  return interpolate(messages.login.signInWithSsoBrand, { brand: brandName });
}

export async function LoginPage({
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

  const messages = await getDictionary(locale);
  const query = searchParams ? await searchParams : {};
  const queryError =
    typeof query.error === "string" ? query.error : Array.isArray(query.error) ? query.error[0] : undefined;
  const loginError = resolveLoginErrorMessage(queryError, messages);
  const oidcEnabled = isOidcEnabled();
  const oidcButtonLabel = resolveOidcButtonLabel(messages);
  const primaryAuthMethod = resolveLoginPrimaryAuthMethod(oidcEnabled);

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
          {loginError ? (
            <p className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {loginError}
            </p>
          ) : null}
          <LoginForm
            locale={locale}
            messages={messages}
            oidcEnabled={oidcEnabled}
            oidcButtonLabel={oidcButtonLabel}
            primaryAuthMethod={primaryAuthMethod}
          />
        </div>
        {!oidcEnabled ? (
          <p className="mt-4 text-xs text-[color:var(--text-tertiary)]">{messages.login.oidcUnavailableHint}</p>
        ) : null}
      </div>
    </main>
  );
}
