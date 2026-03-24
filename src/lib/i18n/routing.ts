import type { Locale } from "@/lib/i18n/config";
import { CHINESE_LOCALE, DEFAULT_LOCALE } from "@/lib/i18n/config";

export function localePrefix(locale: Locale) {
  return locale === CHINESE_LOCALE ? "/zh" : "";
}

export function localizeHref(locale: Locale, path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) {
    return normalized === "/zh" ? "/" : normalized;
  }

  if (normalized === "/") {
    return "/zh";
  }

  return normalized.startsWith("/zh/") || normalized === "/zh" ? normalized : `/zh${normalized}`;
}

export function getLocaleFromPathname(pathname: string): Locale {
  return pathname === "/zh" || pathname.startsWith("/zh/") ? CHINESE_LOCALE : DEFAULT_LOCALE;
}

export function stripLocalePrefix(pathname: string) {
  if (pathname === "/zh") {
    return "/";
  }

  return pathname.startsWith("/zh/") ? pathname.slice(3) : pathname;
}

export function swapLocaleInPath(pathname: string, targetLocale: Locale) {
  return localizeHref(targetLocale, stripLocalePrefix(pathname));
}
