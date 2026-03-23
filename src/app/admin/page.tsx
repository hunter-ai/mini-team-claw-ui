import Link from "next/link";
import { AdminUserManager } from "@/components/admin-user-manager";
import { LogoutButton } from "@/components/logout-button";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export default async function AdminPage() {
  await requireAdmin();
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      username: true,
      role: true,
      openclawAgentId: true,
      isActive: true,
    },
  });

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-col gap-4 rounded-[2rem] border border-white/10 bg-black/20 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-amber-300/70">Admin console</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Manage member identity and agent mapping.</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/chat"
            className="rounded-full border border-white/20 px-3 py-2 text-sm font-medium text-stone-100 transition hover:border-amber-400/80 hover:text-amber-200"
          >
            Back to chat
          </Link>
          <LogoutButton />
        </div>
      </header>
      <AdminUserManager initialUsers={users} />
    </main>
  );
}
