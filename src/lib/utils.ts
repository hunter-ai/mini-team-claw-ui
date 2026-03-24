import type { Locale } from "@/lib/i18n/config";

export function formatRelativeDate(value: Date | string | null | undefined, locale: Locale, emptyLabel: string) {
  if (!value) {
    return emptyLabel;
  }

  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
