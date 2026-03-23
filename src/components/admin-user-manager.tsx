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
};

export function AdminUserManager({ initialUsers }: { initialUsers: AdminUser[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [message, setMessage] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [actionUserId, setActionUserId] = useState<string | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
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
    setCreateLoading(true);
    setMessage(null);

    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    setCreateLoading(false);

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
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isActive: !user.isActive,
      }),
    });

    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? "Failed to update member");
      return;
    }

    setMessage(user.isActive ? "Member disabled" : "Member enabled");
    await refreshUsers();
  }

  async function resetPassword(user: AdminUser) {
    const password = passwordDrafts[user.id]?.trim() ?? "";
    if (password.length < 8) {
      setMessage("New password must be at least 8 characters.");
      return;
    }

    setMessage(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? "Failed to reset password");
      return;
    }

    setPasswordDrafts((current) => ({ ...current, [user.id]: "" }));
    setMessage(`Password reset for ${user.username}. Existing sessions were signed out.`);
    await refreshUsers();
  }

  async function deleteUser(user: AdminUser) {
    if (user.isActive) {
      setMessage("Only disabled users can be deleted.");
      return;
    }

    setMessage(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "DELETE",
    });
    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? "Failed to delete user");
      return;
    }

    setUsers((current) => current.filter((candidate) => candidate.id !== user.id));
    setPasswordDrafts((current) => {
      const next = { ...current };
      delete next[user.id];
      return next;
    });
    setMessage(`Deleted ${user.username}.`);
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
              className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-medium text-stone-100">{user.username}</p>
                  <p className="text-sm text-stone-400">
                    {user.openclawAgentId} · {user.role} · {user.isActive ? "Active" : "Disabled"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => toggleUser(user)}
                    disabled={actionUserId === user.id}
                    className="rounded-full border border-white/12 px-3 py-2 text-sm text-stone-200 transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionUserId === user.id ? "Saving..." : user.isActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteUser(user)}
                    disabled={user.isActive || actionUserId === user.id}
                    title={user.isActive ? "Only disabled users can be deleted." : undefined}
                    className="rounded-full border border-red-400/25 px-3 py-2 text-sm text-red-200 transition hover:border-red-300 hover:text-red-100 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-stone-500"
                  >
                    Delete user
                  </button>
                </div>
              </div>
              <div className="mt-4 flex flex-col gap-2 md:flex-row">
                <input
                  type="password"
                  minLength={8}
                  value={passwordDrafts[user.id] ?? ""}
                  onChange={(event) =>
                    setPasswordDrafts((current) => ({
                      ...current,
                      [user.id]: event.target.value,
                    }))
                  }
                  className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-400"
                  placeholder="new password"
                />
                <button
                  type="button"
                  onClick={() => resetPassword(user)}
                  disabled={actionUserId === user.id}
                  className="rounded-2xl border border-amber-400/30 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:border-amber-300 hover:text-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Force reset password
                </button>
              </div>
              {user.isActive ? (
                <p className="mt-2 text-xs text-stone-500">Only disabled users can be deleted.</p>
              ) : null}
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
            disabled={createLoading}
            className="rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:bg-amber-100"
          >
            {createLoading ? "Creating..." : "Create member"}
          </button>
        </form>
        {message ? <p className="mt-3 text-sm text-stone-300">{message}</p> : null}
      </section>
    </div>
  );
}
