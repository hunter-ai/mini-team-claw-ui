"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className="rounded-full border border-white/20 px-3 py-2 text-sm font-medium text-stone-100 transition hover:border-amber-400/80 hover:text-amber-200"
    >
      Sign out
    </button>
  );
}
