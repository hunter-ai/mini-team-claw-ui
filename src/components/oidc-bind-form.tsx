"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";

export function OidcBindForm({
  locale,
  messages,
  suggestedUsername,
}: {
  locale: Locale;
  messages: Dictionary;
  suggestedUsername?: string;
}) {
  const router = useRouter();
  const [username, setUsername] = useState(suggestedUsername ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const response = await fetch("/api/auth/oidc/bind", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [LOCALE_HEADER_NAME]: locale,
      },
      body: JSON.stringify({ username, password }),
    });

    setLoading(false);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? messages.login.bindFailed);
      return;
    }

    router.push(localizeHref(locale, "/chat"));
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="ui-form-stack">
      <div className="space-y-2.5">
        <label className="text-sm font-medium text-[color:var(--text-secondary)]" htmlFor="bind-username">
          {messages.login.username}
        </label>
        <input
          id="bind-username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="ui-input ring-0"
          placeholder={messages.login.usernamePlaceholder}
          autoComplete="username"
          required
        />
      </div>
      <div className="space-y-2.5">
        <label className="text-sm font-medium text-[color:var(--text-secondary)]" htmlFor="bind-password">
          {messages.login.password}
        </label>
        <input
          id="bind-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="ui-input ring-0"
          placeholder={messages.login.passwordPlaceholder}
          autoComplete="current-password"
          required
        />
      </div>
      {error ? <p className="ui-field-note text-red-600">{error}</p> : null}
      <button
        type="submit"
        disabled={loading}
        className="ui-button-primary w-full font-semibold disabled:cursor-not-allowed"
      >
        {loading ? messages.login.binding : messages.login.bindSubmit}
      </button>
    </form>
  );
}
