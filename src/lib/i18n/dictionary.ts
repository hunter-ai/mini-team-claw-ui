import type { Locale } from "@/lib/i18n/config";

const dictionaries = {
  en: () => import("@/lib/i18n/dictionaries/en").then((module) => module.default),
  zh: () => import("@/lib/i18n/dictionaries/zh").then((module) => module.default),
};

export type Dictionary = Awaited<ReturnType<(typeof dictionaries)[Locale]>>;

export async function getDictionary(locale: Locale): Promise<Dictionary> {
  return dictionaries[locale]();
}

export function interpolate(template: string, params: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));
}
