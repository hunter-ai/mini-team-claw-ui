"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";

export function LoginForm({
  locale,
  messages,
  oidcEnabled,
  oidcButtonLabel,
}: {
  locale: Locale;
  messages: Dictionary;
  oidcEnabled: boolean;
  oidcButtonLabel: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify({ username, password }),
    });

    setLoading(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? messages.login.failed);
      return;
    }

    router.push(localizeHref(locale, "/chat"));
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {oidcEnabled ? (
        <>
          <a
            href={`/api/auth/oidc/start?locale=${locale}`}
            className="ui-button-primary flex w-full items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold"
          >
            {oidcButtonLabel}
          </a>
          <div className="relative py-1 text-center">
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[color:var(--border-subtle)]" />
            <span className="relative bg-[color:var(--surface-primary)] px-3 text-xs uppercase tracking-[0.24em] text-[color:var(--text-quaternary)]">
              {messages.login.orContinueWithPassword}
            </span>
          </div>
        </>
      ) : null}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[color:var(--text-secondary)]" htmlFor="username">
            {messages.login.username}
          </label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="ui-input w-full rounded-2xl px-4 py-3 ring-0"
            placeholder={messages.login.usernamePlaceholder}
            autoComplete="username"
            required
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-[color:var(--text-secondary)]" htmlFor="password">
            {messages.login.password}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="ui-input w-full rounded-2xl px-4 py-3 ring-0"
            placeholder={messages.login.passwordPlaceholder}
            autoComplete="current-password"
            required
          />
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="ui-button-secondary w-full rounded-2xl px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed"
        >
          {loading ? messages.login.submitting : messages.login.submit}
        </button>
      </form>
    </div>
  );
}
