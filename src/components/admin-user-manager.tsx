"use client";

import { useMemo, useState } from "react";

type AdminUser = {
  id: string;
  username: string;
  role: "ADMIN" | "MEMBER";
  openclawAgentId: string;
  isActive: boolean;
};

type GatewayPairingSummary = {
  status: "healthy" | "pairing_required" | "approving" | "failed";
  message: string | null;
  deviceId: string;
  lastPairedAt: string | null;
  tokenScopes: string[];
  pendingRequests: Array<{
    requestId: string | null;
    requestedAt: string | null;
    scopes: string[];
    clientId: string | null;
    clientMode: string | null;
    clientPlatform: string | null;
    message: string | null;
  }>;
}

export function AdminUserManager({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    openclawAgentId: "",
    role: "MEMBER",
  });

  const activeCount = useMemo(() => users.filter((user) => user.isActive).length, [users]);

  async function refreshUsers() {
    const response = await fetch("/api/admin/users");
    const payload = (await response.json()) as { users: AdminUser[] };
    setUsers(payload.users);
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    setLoading(false);

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      pairing?: GatewayPairingSummary;
    };

    if (!response.ok) {
      setMessage(payload.error ?? "Failed to create user");
      return;
    }

    setForm({ username: "", password: "", openclawAgentId: "", role: "MEMBER" });
    if (payload.pairing) {
      if (payload.pairing.status === "healthy") {
        setMessage("Member created. Device pairing is ready.");
      } else if (payload.pairing.status === "pairing_required") {
        setMessage("Member created. Device pairing is still pending approval.");
      } else if (payload.pairing.status === "failed") {
        setMessage("Member created. Device pairing precheck failed.");
      } else {
        setMessage("Member created. Device pairing is being processed.");
      }
    } else {
      setMessage("Member created");
    }
    await refreshUsers();
  }

  async function toggleUser(user: AdminUser) {
    setMessage(null);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isActive: !user.isActive,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? "Failed to update member");
      return;
    }

    await refreshUsers();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/5 p-5 shadow-[0_25px_80px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-amber-300/70">Members</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">{activeCount} active seats</h2>
          </div>
        </div>
        <div className="mt-5 space-y-3">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
            >
              <div>
                <p className="font-medium text-stone-100">{user.username}</p>
                <p className="text-sm text-stone-400">
                  {user.openclawAgentId} · {user.role}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleUser(user)}
                className="rounded-full border border-white/12 px-3 py-2 text-sm text-stone-200 transition hover:border-amber-400 hover:text-amber-200"
              >
                {user.isActive ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-white/5 p-5 shadow-[0_25px_80px_rgba(0,0,0,0.35)]">
        <p className="text-xs uppercase tracking-[0.3em] text-amber-300/70">Create member</p>
        <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={createUser}>
          <input
            value={form.username}
            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
            className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-400"
            placeholder="username"
            required
          />
          <input
            value={form.openclawAgentId}
            onChange={(event) =>
              setForm((current) => ({ ...current, openclawAgentId: event.target.value }))
            }
            className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-400"
            placeholder="agent id"
            required
          />
          <input
            type="password"
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-400"
            placeholder="password"
            required
          />
          <select
            value={form.role}
            onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
            className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-stone-100 outline-none focus:border-amber-400"
          >
            <option value="MEMBER">Member</option>
            <option value="ADMIN">Admin</option>
          </select>
          <button
            type="submit"
            disabled={loading}
            className="rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:bg-amber-100"
          >
            {loading ? "Creating..." : "Create member"}
          </button>
        </form>
        {message ? <p className="mt-3 text-sm text-stone-300">{message}</p> : null}
      </section>
    </div>
  );
}
