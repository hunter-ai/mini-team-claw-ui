"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AdminNavSection } from "@/app/_shared/admin-navigation";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref, stripLocalePrefix } from "@/lib/i18n/routing";

export function AdminShellNav({
  locale,
  sections,
  title,
  onNavigate,
}: {
  locale: Locale;
  sections: AdminNavSection[];
  title: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const normalizedPath = stripLocalePrefix(pathname);

  return (
    <nav aria-label={title} className="space-y-4">
      {sections.map((section) => (
        <div key={section.key} className="space-y-2">
          <p className="px-1 text-[11px] uppercase tracking-[0.28em] text-[color:var(--text-quaternary)]">
            {section.label}
          </p>
          <div className="space-y-2">
            {section.items.map((item) => {
              const isActive =
                normalizedPath === item.href ||
                (item.href !== "/admin" && normalizedPath.startsWith(`${item.href}/`));

              return (
                <Link
                  key={item.key}
                  href={localizeHref(locale, item.href)}
                  onClick={onNavigate}
                  className={[
                    "block rounded-[1.35rem] border px-4 py-3",
                    isActive
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)] ring-1 ring-[rgba(15,23,42,0.05)] shadow-[0_6px_16px_rgba(15,23,42,0.05)]"
                      : "border-transparent bg-transparent text-[color:var(--text-secondary)] hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface-subtle)] hover:text-[color:var(--text-primary)]",
                  ].join(" ")}
                >
                  <p className="text-sm font-semibold">{item.label}</p>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
