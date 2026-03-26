import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { localizeHref } from "@/lib/i18n/routing";
import {
  clearPendingOidcBinding,
  clearOidcFlowCookies,
  findUserFromOidcClaims,
  getOidcBindRedirectUrl,
  getOidcCallbackLocale,
  getOidcConfig,
  getOidcLoginRedirectUrl,
  setPendingOidcBinding,
  verifyOidcCallback,
} from "@/lib/oidc";
import { getSetupStatus } from "@/lib/setup";

function redirectWithError(request: Request, locale: "en" | "zh", error: string) {
  return NextResponse.redirect(
    new URL(getOidcLoginRedirectUrl(locale, error), getOidcConfig()?.appUrl ?? request.url),
  );
}

export async function GET(request: Request) {
  const locale = await getOidcCallbackLocale();
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (error) {
    await clearPendingOidcBinding();
    await clearOidcFlowCookies();
    return redirectWithError(request, locale, "oidc_failed");
  }

  const setupStatus = await getSetupStatus();
  if (!setupStatus.isComplete) {
    await clearPendingOidcBinding();
    await clearOidcFlowCookies();
    return NextResponse.redirect(
      new URL(getOidcLoginRedirectUrl(locale, "oidc_failed"), getOidcConfig()?.appUrl ?? request.url),
    );
  }

  try {
    if (!getOidcConfig() || !state || !code) {
      await clearPendingOidcBinding();
      await clearOidcFlowCookies();
      return redirectWithError(request, locale, "oidc_unavailable");
    }

    const claims = await verifyOidcCallback({ state, code });
    const match = await findUserFromOidcClaims(claims);

    if (!match.ok) {
      await clearOidcFlowCookies();

      if (match.reason === "user_disabled") {
        await clearPendingOidcBinding();
        return redirectWithError(request, locale, "oidc_user_disabled");
      }

      await setPendingOidcBinding(claims);
      return NextResponse.redirect(
        new URL(getOidcBindRedirectUrl(locale), getOidcConfig()?.appUrl ?? request.url),
      );
    }

    await clearPendingOidcBinding();
    await clearOidcFlowCookies();
    await createSession(match.user.id);
    return NextResponse.redirect(
      new URL(localizeHref(locale, "/chat"), getOidcConfig()?.appUrl ?? request.url),
    );
  } catch {
    await clearPendingOidcBinding();
    await clearOidcFlowCookies();
    return redirectWithError(request, locale, "oidc_failed");
  }
}
