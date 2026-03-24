import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";

export async function HomePage({ locale }: { locale: Locale }) {
  const user = await getCurrentUser();
  if (user) {
    redirect(localizeHref(locale, "/chat"));
  }

  redirect(localizeHref(locale, "/login"));
}
