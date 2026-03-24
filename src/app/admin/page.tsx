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
      <header className="ui-card mb-6 flex flex-col gap-4 rounded-[2rem] px-5 py-5 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">Admin console</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            Manage member identity and agent mapping.
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/chat"
            className="ui-button-secondary rounded-full px-3 py-2 text-sm font-medium"
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
