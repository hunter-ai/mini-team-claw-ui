"use client";

import { useRouter } from "next/navigation";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";

export function LogoutButton({
  className,
  locale,
  messages,
}: {
  className?: string;
  locale: Locale;
  messages: Dictionary;
}) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", headers: { [LOCALE_HEADER_NAME]: locale } });
    router.push(localizeHref(locale, "/login"));
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className={
        className ??
        "ui-button-secondary rounded-full px-3 py-2 text-sm font-medium"
      }
    >
      {messages.auth.signOut}
    </button>
  );
}
