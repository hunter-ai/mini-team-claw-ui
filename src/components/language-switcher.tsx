"use client";

import { usePathname, useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { LOCALE_COOKIE_NAME, type Locale } from "@/lib/i18n/config";
import { swapLocaleInPath } from "@/lib/i18n/routing";

function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function LanguageSwitcher({
  locale,
  messages,
  className,
}: {
  locale: Locale;
  messages: Dictionary;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  function switchLocale(nextLocale: Locale) {
    if (nextLocale === locale) {
      return;
    }

    setLocaleCookie(nextLocale);
    const nextPath = swapLocaleInPath(pathname, nextLocale);
    const query = typeof window === "undefined" ? "" : window.location.search.slice(1);
    router.push(query ? `${nextPath}?${query}` : nextPath);
    router.refresh();
  }

  return (
    <div className={className ?? "inline-flex items-center gap-1 rounded-full border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.72)] p-1 text-[11px]"}>
      <button
        type="button"
        onClick={() => switchLocale("en")}
        className={`rounded-full px-2.5 py-1 ${locale === "en" ? "ui-button-secondary" : "text-[color:var(--text-secondary)]"}`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => switchLocale("zh")}
        className={`rounded-full px-2.5 py-1 ${locale === "zh" ? "ui-button-secondary" : "text-[color:var(--text-secondary)]"}`}
      >
        {messages.common.switchToLanguage}
      </button>
    </div>
  );
}
