import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  LOCALE_HEADER_NAME,
  type Locale,
  normalizeLocale,
} from "@/lib/i18n/config";

export async function getCookieLocale() {
  const cookieStore = await cookies();
  return normalizeLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
}

export async function getCurrentLocaleFromHeaders() {
  const headerStore = await headers();
  return normalizeLocale(headerStore.get(LOCALE_HEADER_NAME));
}

export function getRequestLocale(request: Request | NextRequest) {
  const url = new URL(request.url);
  return normalizeLocale(url.searchParams.get("locale") ?? request.headers.get(LOCALE_HEADER_NAME) ?? DEFAULT_LOCALE);
}

export async function resolveRequestLocale(request?: Request | NextRequest): Promise<Locale> {
  if (request) {
    return getRequestLocale(request);
  }

  const headerLocale = await getCurrentLocaleFromHeaders();
  if (headerLocale !== DEFAULT_LOCALE) {
    return headerLocale;
  }

  return getCookieLocale();
}
