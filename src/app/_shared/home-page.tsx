import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";
import { redirectToSetupIfNeeded } from "@/lib/setup";

export async function HomePage({ locale }: { locale: Locale }) {
  await redirectToSetupIfNeeded(locale);
  const user = await getCurrentUser();
  if (user) {
    redirect(localizeHref(locale, "/chat"));
  }

  redirect(localizeHref(locale, "/login"));
}
