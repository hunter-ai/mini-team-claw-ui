"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { LOCALE_COOKIE_NAME } from "@/lib/i18n/config";
import { swapLocaleInPath } from "@/lib/i18n/routing";

function setLocaleCookie(locale: "en" | "zh") {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function LanguagePrompt({ messages }: { messages: Dictionary }) {
  const router = useRouter();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  const shouldOfferChinese = useMemo(() => {
    if (pathname.startsWith("/zh") || dismissed || typeof document === "undefined") {
      return false;
    }

    if (document.cookie.includes(`${LOCALE_COOKIE_NAME}=`)) {
      return false;
    }

    return navigator.languages.some((language) => language.toLowerCase().startsWith("zh"));
  }, [dismissed, pathname]);

  if (!shouldOfferChinese) {
    return null;
  }

  function dismiss() {
    setLocaleCookie("en");
    setDismissed(true);
  }

  function switchToChinese() {
    setLocaleCookie("zh");
    const nextPath = swapLocaleInPath(pathname, "zh");
    const query = typeof window === "undefined" ? "" : window.location.search.slice(1);
    router.push(query ? `${nextPath}?${query}` : nextPath);
    router.refresh();
  }

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm rounded-[1rem] border border-[color:var(--border-strong)] bg-[rgba(255,255,255,0.96)] p-4 shadow-[var(--shadow-panel)]">
      <p className="text-sm font-semibold text-[color:var(--text-primary)]">{messages.localePrompt.title}</p>
      <p className="mt-1.5 text-xs leading-6 text-[color:var(--text-secondary)]">{messages.localePrompt.description}</p>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={dismiss} className="ui-button-secondary rounded-full px-3 py-1.5 text-xs">
          {messages.localePrompt.dismiss}
        </button>
        <button type="button" onClick={switchToChinese} className="ui-button-primary rounded-full px-3 py-1.5 text-xs font-semibold">
          {messages.localePrompt.confirm}
        </button>
      </div>
    </div>
  );
}
