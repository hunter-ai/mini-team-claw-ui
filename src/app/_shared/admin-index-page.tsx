import { redirect } from "next/navigation";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";

export function AdminIndexPage({ locale }: { locale: Locale }) {
  redirect(localizeHref(locale, "/admin/members"));
}
