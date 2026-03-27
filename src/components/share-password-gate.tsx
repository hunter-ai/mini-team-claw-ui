"use client";

import { useState, useTransition } from "react";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";

export function SharePasswordGate({
  publicId,
  locale,
  messages,
}: {
  publicId: string;
  locale: Locale;
  messages: Dictionary;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-4">
      <div className="ui-card w-full rounded-[1rem] p-5">
        <p className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--text-tertiary)]">{messages.share.eyebrow}</p>
        <h1 className="mt-2 text-lg font-semibold text-[color:var(--text-primary)]">{messages.share.passwordTitle}</h1>
        <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.share.passwordDescription}</p>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);

            startTransition(async () => {
              const response = await fetch(`/api/share/${publicId}/access`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  [LOCALE_HEADER_NAME]: locale,
                },
                body: JSON.stringify({ password }),
              }).catch((fetchError) => fetchError);

              if (response instanceof Error) {
                setError(response.message);
                return;
              }

              const rawText = await response.text();
              if (!response.ok) {
                try {
                  const payload = JSON.parse(rawText) as { error?: string };
                  setError(payload.error ?? messages.share.passwordFailed);
                } catch {
                  setError(rawText || messages.share.passwordFailed);
                }
                return;
              }

              window.location.reload();
            });
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={isPending}
            className="ui-input w-full rounded-[0.8rem] px-3 py-2 text-sm"
            placeholder={messages.share.passwordPlaceholder}
          />
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
          <button
            type="submit"
            disabled={isPending || !password.trim()}
            className="ui-button-primary mt-4 w-full rounded-full px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed"
          >
            {isPending ? messages.share.passwordSubmitting : messages.share.passwordSubmit}
          </button>
        </form>
      </div>
    </div>
  );
}
