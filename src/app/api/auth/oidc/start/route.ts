import { NextResponse } from "next/server";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { localizeHref } from "@/lib/i18n/routing";
import { clearPendingOidcBinding, createOidcAuthorizationUrl, getOidcConfig } from "@/lib/oidc";
import { getSetupStatus } from "@/lib/setup";

export async function GET(request: Request) {
  const locale = getRequestLocale(request);
  const setupStatus = await getSetupStatus();
  const appUrl = getOidcConfig()?.appUrl;

  if (!setupStatus.isComplete) {
    return NextResponse.redirect(new URL(localizeHref(locale, "/setup"), appUrl ?? request.url));
  }

  try {
    await clearPendingOidcBinding();
    if (!getOidcConfig()) {
      return NextResponse.redirect(new URL(localizeHref(locale, "/login?error=oidc_unavailable"), appUrl ?? request.url));
    }

    const authorizationUrl = await createOidcAuthorizationUrl(locale);
    return NextResponse.redirect(authorizationUrl);
  } catch {
    return NextResponse.redirect(new URL(localizeHref(locale, "/login?error=oidc_unavailable"), appUrl ?? request.url));
  }
}
