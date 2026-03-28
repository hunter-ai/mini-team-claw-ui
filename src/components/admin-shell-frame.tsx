"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AdminNavSection } from "@/app/_shared/admin-navigation";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import { AdminShellNav } from "./admin-shell-nav";
import { LanguageSwitcher } from "./language-switcher";

export function AdminShellFrame({
  children,
  locale,
  messages,
  sections,
}: {
  children: React.ReactNode;
  locale: Locale;
  messages: Dictionary;
  sections: AdminNavSection[];
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, [drawerOpen]);

  const sidebar = (
    <>
      <div className="border-b border-[color:var(--border-subtle)] px-5 py-5">
        <div className="flex items-start justify-between gap-3 lg:block">
          <div>
            <p className="text-[11px] uppercase tracking-[0.32em] text-[color:var(--text-tertiary)]">
              {messages.admin.eyebrow}
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
              {messages.admin.shellTitle}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="ui-button-secondary ui-icon-button !inline-flex shrink-0 lg:!hidden"
            aria-label={messages.admin.closeSidebarMenu}
            title={messages.admin.closeSidebarMenu}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col gap-5 p-4 lg:justify-between">
        <div className="min-h-0 overflow-y-auto pr-1">
          <AdminShellNav
            locale={locale}
            sections={sections}
            title={messages.admin.navigationTitle}
            onNavigate={() => setDrawerOpen(false)}
          />
        </div>

        <div className="border-t border-[color:var(--border-subtle)] pt-4 lg:border-t-0 lg:pt-0">
          <div className="flex flex-wrap gap-2">
            <LanguageSwitcher locale={locale} messages={messages} />
            <Link
              href={localizeHref(locale, "/chat")}
              onClick={() => setDrawerOpen(false)}
              className="ui-button-secondary ui-button-chip font-medium"
            >
              {messages.nav.backToChat}
            </Link>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-[96rem] px-3 py-3 sm:px-6 sm:py-4 lg:px-8">
      <div className="space-y-4 lg:grid lg:grid-cols-[18.5rem_minmax(0,1fr)] lg:gap-4 lg:space-y-0">
        <div className="flex items-center justify-between gap-3 rounded-[1.5rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.78)] px-4 py-3.5 shadow-[var(--shadow-soft)] lg:hidden">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.26em] text-[color:var(--text-tertiary)]">
              {messages.admin.eyebrow}
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-[color:var(--text-primary)]">
              {messages.admin.shellTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="ui-button-secondary ui-icon-button shrink-0"
            aria-label={messages.admin.openSidebarMenu}
            title={messages.admin.openSidebarMenu}
          >
            <MenuIcon />
          </button>
        </div>

        {drawerOpen ? (
          <button
            type="button"
            aria-label={messages.admin.closeSidebarMenu}
            onClick={() => setDrawerOpen(false)}
            className="ui-overlay fixed inset-0 z-20 lg:hidden"
          />
        ) : null}

        <aside
          className={`fixed inset-y-1.5 left-1.5 z-30 flex w-[calc(100vw-0.75rem)] max-w-[22rem] flex-col overflow-hidden rounded-[1.75rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] shadow-[var(--shadow-panel)] transition-transform duration-300 lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)] lg:w-auto lg:max-w-none lg:bg-[color:var(--surface-panel)] ${
            drawerOpen ? "translate-x-0" : "-translate-x-[108%] lg:translate-x-0"
          }`}
        >
          {sidebar}
        </aside>

        <div className="space-y-4 lg:min-w-0">{children}</div>
      </div>
    </main>
  );
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className="size-4"
    >
      <path d="M3.5 5.5h13" strokeLinecap="round" />
      <path d="M3.5 10h13" strokeLinecap="round" />
      <path d="M3.5 14.5h13" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className="size-4"
    >
      <path d="M5 5l10 10" strokeLinecap="round" />
      <path d="M15 5 5 15" strokeLinecap="round" />
    </svg>
  );
}
