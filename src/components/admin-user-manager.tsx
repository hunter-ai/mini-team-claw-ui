"use client";

import { useMemo, useState } from "react";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { t } from "@/lib/i18n/messages";

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

export function AdminUserManager({
  initialUsers,
  locale,
  messages,
}: {
  initialUsers: AdminUser[];
  locale: Locale;
  messages: Dictionary;
}) {
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
    const response = await fetch("/api/admin/users", {
      headers: { [LOCALE_HEADER_NAME]: locale },
    });
    const payload = (await response.json()) as { users: AdminUser[] };
    setUsers(payload.users);
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateLoading(true);
    setMessage(null);

    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify(form),
    });

    setCreateLoading(false);

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      pairing?: GatewayPairingSummary;
    };

    if (!response.ok) {
      setMessage(payload.error ?? messages.admin.failedToCreateUser);
      return;
    }

    setForm({ username: "", password: "", openclawAgentId: "", role: "MEMBER" });
    if (payload.pairing) {
      if (payload.pairing.status === "healthy") {
        setMessage(messages.admin.memberCreatedPairingReady);
      } else if (payload.pairing.status === "pairing_required") {
        setMessage(messages.admin.memberCreatedPairingPending);
      } else if (payload.pairing.status === "failed") {
        setMessage(messages.admin.memberCreatedPairingFailed);
      } else {
        setMessage(messages.admin.memberCreatedPairingProcessing);
      }
    } else {
      setMessage(messages.admin.memberCreated);
    }
    await refreshUsers();
  }

  async function toggleUser(user: AdminUser) {
    setMessage(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify({
        isActive: !user.isActive,
      }),
    });

    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? messages.admin.failedToUpdateMember);
      return;
    }

    setMessage(user.isActive ? messages.admin.memberDisabled : messages.admin.memberEnabled);
    await refreshUsers();
  }

  async function resetPassword(user: AdminUser) {
    const password = passwordDrafts[user.id]?.trim() ?? "";
    if (password.length < 8) {
      setMessage(messages.admin.passwordTooShort);
      return;
    }

    setMessage(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify({ password }),
    });
    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? messages.admin.failedToResetPassword);
      return;
    }

    setPasswordDrafts((current) => ({ ...current, [user.id]: "" }));
    setMessage(t(messages.admin.passwordReset, { username: user.username }));
    await refreshUsers();
  }

  async function deleteUser(user: AdminUser) {
    if (user.isActive) {
      setMessage(messages.admin.onlyDisabledUsersCanBeDeleted);
      return;
    }

    setMessage(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { [LOCALE_HEADER_NAME]: locale },
    });
    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(payload.error ?? messages.admin.deleteUser);
      return;
    }

    setUsers((current) => current.filter((candidate) => candidate.id !== user.id));
    setPasswordDrafts((current) => {
      const next = { ...current };
      delete next[user.id];
      return next;
    });
    setMessage(t(messages.admin.deletedUser, { username: user.username }));
  }

  return (
    <div className="space-y-6">
      <section className="ui-card rounded-[2rem] p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">{messages.admin.members}</p>
            <h2 className="mt-2 text-2xl font-semibold text-[color:var(--text-primary)]">{t(messages.admin.activeSeats, { count: activeCount })}</h2>
          </div>
        </div>
        <div className="mt-5 space-y-3">
          {users.map((user) => (
            <div key={user.id} className="ui-surface-muted rounded-2xl px-4 py-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-medium text-[color:var(--text-primary)]">{user.username}</p>
                  <p className="text-sm text-[color:var(--text-tertiary)]">
                    {user.openclawAgentId} · {user.role === "ADMIN" ? messages.admin.admin : messages.admin.member} · {user.isActive ? messages.admin.active : messages.admin.disabled}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => toggleUser(user)}
                    disabled={actionUserId === user.id}
                    className="ui-button-secondary rounded-full px-3 py-2 text-sm disabled:cursor-not-allowed"
                  >
                    {actionUserId === user.id ? messages.common.saving : user.isActive ? messages.admin.disable : messages.admin.enable}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteUser(user)}
                    disabled={user.isActive || actionUserId === user.id}
                    title={user.isActive ? messages.admin.onlyDisabledUsersCanBeDeleted : undefined}
                    className="ui-button-danger rounded-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:border-[color:var(--border-subtle)] disabled:bg-transparent disabled:text-[color:var(--text-quaternary)]"
                  >
                    {messages.admin.deleteUser}
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
                  className="ui-input min-w-0 flex-1 rounded-2xl px-4 py-3"
                  placeholder={messages.admin.newPasswordPlaceholder}
                />
                <button
                  type="button"
                  onClick={() => resetPassword(user)}
                  disabled={actionUserId === user.id}
                  className="ui-button-primary rounded-2xl px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed"
                >
                  {messages.admin.forceResetPassword}
                </button>
              </div>
              {user.isActive ? (
                <p className="mt-2 text-xs text-[color:var(--text-quaternary)]">{messages.admin.onlyDisabledUsersCanBeDeleted}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="ui-card rounded-[2rem] p-5">
        <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">{messages.admin.createMember}</p>
        <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={createUser}>
          <input
            value={form.username}
            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
            className="ui-input rounded-2xl px-4 py-3"
            placeholder={messages.admin.usernamePlaceholder}
            required
          />
          <input
            value={form.openclawAgentId}
            onChange={(event) =>
              setForm((current) => ({ ...current, openclawAgentId: event.target.value }))
            }
            className="ui-input rounded-2xl px-4 py-3"
            placeholder={messages.admin.agentIdPlaceholder}
            required
          />
          <input
            type="password"
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            className="ui-input rounded-2xl px-4 py-3"
            placeholder={messages.admin.passwordPlaceholder}
            required
          />
          <select
            value={form.role}
            onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
            className="ui-input rounded-2xl px-4 py-3"
          >
            <option value="MEMBER">{messages.admin.member}</option>
            <option value="ADMIN">{messages.admin.admin}</option>
          </select>
          <button
            type="submit"
            disabled={createLoading}
            className="ui-button-primary rounded-2xl px-4 py-3 text-sm font-semibold"
          >
            {createLoading ? messages.admin.creatingMember : messages.admin.createMemberAction}
          </button>
        </form>
        {message ? <p className="mt-3 text-sm text-[color:var(--text-secondary)]">{message}</p> : null}
      </section>
    </div>
  );
}
