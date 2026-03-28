"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { t } from "@/lib/i18n/messages";

type AdminUser = {
  id: string;
  username: string;
  role: "ADMIN" | "MEMBER";
  openclawAgentId: string;
  isActive: boolean;
  oidcBinding: {
    issuer: string;
    linkedAt: string;
  } | null;
};

export function AdminUserManager({
  initialUsers,
  locale,
  messages,
  variant = "standalone",
}: {
  initialUsers: AdminUser[];
  locale: Locale;
  messages: Dictionary;
  variant?: "standalone" | "embedded";
}) {
  const [users, setUsers] = useState(initialUsers);
  const [message, setMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const [actionUserId, setActionUserId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [resetPasswordTargetUser, setResetPasswordTargetUser] = useState<AdminUser | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const createUsernameInputRef = useRef<HTMLInputElement | null>(null);
  const resetPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    openclawAgentId: "",
    role: "MEMBER",
  });

  const activeCount = useMemo(() => users.filter((user) => user.isActive).length, [users]);

  useEffect(() => {
    if (!isCreateModalOpen) {
      return;
    }

    createUsernameInputRef.current?.focus();
  }, [isCreateModalOpen]);

  useEffect(() => {
    if (!resetPasswordTargetUser) {
      return;
    }

    resetPasswordInputRef.current?.focus();
  }, [resetPasswordTargetUser]);

  useEffect(() => {
    if (!isCreateModalOpen && !resetPasswordTargetUser) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (resetPasswordTargetUser && actionUserId !== resetPasswordTargetUser.id) {
        setResetPasswordTargetUser(null);
        setResetError(null);
        return;
      }

      if (isCreateModalOpen && !createLoading) {
        setIsCreateModalOpen(false);
        setCreateError(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actionUserId, createLoading, isCreateModalOpen, resetPasswordTargetUser]);

  function closeCreateModal() {
    if (createLoading) {
      return;
    }

    setIsCreateModalOpen(false);
    setCreateError(null);
  }

  function openCreateModal() {
    setMessage(null);
    setCreateError(null);
    setIsCreateModalOpen(true);
  }

  function closeResetPasswordModal() {
    if (resetPasswordTargetUser && actionUserId === resetPasswordTargetUser.id) {
      return;
    }

    setResetPasswordTargetUser(null);
    setResetError(null);
  }

  function openResetPasswordModal(user: AdminUser) {
    setMessage(null);
    setResetError(null);
    setResetPasswordTargetUser(user);
  }

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
    setCreateError(null);

    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify(form),
    });

    setCreateLoading(false);

    const payload = (await response.json().catch(() => ({}))) as { error?: string };

    if (!response.ok) {
      setCreateError(payload.error ?? messages.admin.failedToCreateUser);
      return;
    }

    setForm({ username: "", password: "", openclawAgentId: "", role: "MEMBER" });
    setIsCreateModalOpen(false);
    setMessage(messages.admin.memberCreated);
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
      setResetError(messages.admin.passwordTooShort);
      return;
    }

    setMessage(null);
    setResetError(null);
    setActionUserId(user.id);
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
      body: JSON.stringify({ password }),
    });
    setActionUserId(null);

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setResetError(payload.error ?? messages.admin.failedToResetPassword);
      return;
    }

    setPasswordDrafts((current) => ({ ...current, [user.id]: "" }));
    setResetPasswordTargetUser(null);
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

  const membersSection = (
    <section className="ui-card rounded-[2rem] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">{messages.admin.members}</p>
          <h2 className="mt-2 text-2xl font-semibold text-[color:var(--text-primary)]">{t(messages.admin.activeSeats, { count: activeCount })}</h2>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="ui-button-primary ui-button-chip font-semibold"
        >
          {messages.admin.createMemberAction}
        </button>
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
                <p className="mt-1 text-xs text-[color:var(--text-quaternary)]">
                  {user.oidcBinding ? messages.admin.ssoBound : messages.admin.ssoNotBound}
                  {user.oidcBinding ? ` · ${messages.admin.linkedIdentity}: ${user.oidcBinding.issuer}` : ""}
                  {user.oidcBinding
                    ? ` · ${messages.admin.linkedAt}: ${new Date(user.oidcBinding.linkedAt).toLocaleString(locale)}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => openResetPasswordModal(user)}
                  disabled={actionUserId === user.id}
                  className="ui-button-secondary ui-button-chip disabled:cursor-not-allowed"
                >
                  {messages.admin.forceResetPassword}
                </button>
                <button
                  type="button"
                  onClick={() => toggleUser(user)}
                  disabled={actionUserId === user.id}
                  className="ui-button-secondary ui-button-chip disabled:cursor-not-allowed"
                >
                  {actionUserId === user.id ? messages.common.saving : user.isActive ? messages.admin.disable : messages.admin.enable}
                </button>
                <button
                  type="button"
                  onClick={() => deleteUser(user)}
                  disabled={user.isActive || actionUserId === user.id}
                  title={user.isActive ? messages.admin.onlyDisabledUsersCanBeDeleted : undefined}
                  className="ui-button-danger ui-button-chip disabled:cursor-not-allowed disabled:border-[color:var(--border-subtle)] disabled:bg-transparent disabled:text-[color:var(--text-quaternary)]"
                >
                  {messages.admin.deleteUser}
                </button>
              </div>
            </div>
            {user.isActive ? (
              <p className="mt-2 text-xs text-[color:var(--text-quaternary)]">{messages.admin.onlyDisabledUsersCanBeDeleted}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );

  const createMemberModal = isCreateModalOpen ? (
    <div className="ui-overlay fixed inset-0 z-40 flex items-end justify-center px-4 py-4 sm:items-center">
      <button
        type="button"
        aria-label={messages.admin.closeCreateMemberModal}
        onClick={closeCreateModal}
        className="absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-member-modal-title"
        className="ui-card ui-dialog relative z-10"
      >
        <div className="mb-4">
          <p id="create-member-modal-title" className="text-sm font-semibold text-[color:var(--text-primary)]">
            {messages.admin.createMember}
          </p>
          <p className="ui-field-note mt-1">{messages.admin.createMemberModalDescription}</p>
        </div>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={createUser}>
          <input
            ref={createUsernameInputRef}
            value={form.username}
            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
            className="ui-input"
            placeholder={messages.admin.usernamePlaceholder}
            required
          />
          <input
            value={form.openclawAgentId}
            onChange={(event) =>
              setForm((current) => ({ ...current, openclawAgentId: event.target.value }))
            }
            className="ui-input"
            placeholder={messages.admin.agentIdPlaceholder}
            required
          />
          <input
            type="password"
            value={form.password}
            onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            className="ui-input"
            placeholder={messages.admin.passwordPlaceholder}
            required
          />
          <select
            value={form.role}
            onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as "ADMIN" | "MEMBER" }))}
            className="ui-input"
          >
            <option value="MEMBER">{messages.admin.member}</option>
            <option value="ADMIN">{messages.admin.admin}</option>
          </select>
          {createError ? <p className="text-sm text-red-600 md:col-span-2">{createError}</p> : null}
          <div className="ui-dialog-actions md:col-span-2">
            <button
              type="button"
              onClick={closeCreateModal}
              disabled={createLoading}
              className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
            >
              {messages.common.cancel}
            </button>
            <button
              type="submit"
              disabled={createLoading}
              className="ui-button-primary ui-button-chip font-semibold disabled:cursor-not-allowed"
            >
              {createLoading ? messages.admin.creatingMember : messages.admin.createMemberAction}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  const resetPasswordModal = resetPasswordTargetUser ? (
    <div className="ui-overlay fixed inset-0 z-40 flex items-end justify-center px-4 py-4 sm:items-center">
      <button
        type="button"
        aria-label={messages.admin.closeResetPasswordModal}
        onClick={closeResetPasswordModal}
        className="absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-password-modal-title"
        className="ui-card ui-dialog relative z-10 w-full max-w-md"
      >
        <div className="mb-4">
          <p id="reset-password-modal-title" className="text-sm font-semibold text-[color:var(--text-primary)]">
            {t(messages.admin.resetPasswordModalTitle, { username: resetPasswordTargetUser.username })}
          </p>
          <p className="ui-field-note mt-1">{messages.admin.resetPasswordModalDescription}</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void resetPassword(resetPasswordTargetUser);
          }}
        >
          <label className="block">
            <span className="sr-only">{messages.admin.newPasswordPlaceholder}</span>
            <input
              ref={resetPasswordInputRef}
              type="password"
              minLength={8}
              value={passwordDrafts[resetPasswordTargetUser.id] ?? ""}
              onChange={(event) =>
                setPasswordDrafts((current) => ({
                  ...current,
                  [resetPasswordTargetUser.id]: event.target.value,
                }))
              }
              className="ui-input"
              placeholder={messages.admin.newPasswordPlaceholder}
            />
          </label>
          <p className="ui-field-note mt-2 text-[color:var(--text-quaternary)]">{messages.admin.resetPasswordSessionHint}</p>
          {resetError ? <p className="mt-3 text-sm text-red-600">{resetError}</p> : null}
          <div className="ui-dialog-actions mt-4">
            <button
              type="button"
              onClick={closeResetPasswordModal}
              disabled={actionUserId === resetPasswordTargetUser.id}
              className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
            >
              {messages.common.cancel}
            </button>
            <button
              type="submit"
              disabled={actionUserId === resetPasswordTargetUser.id}
              className="ui-button-primary ui-button-chip font-semibold disabled:cursor-not-allowed"
            >
              {actionUserId === resetPasswordTargetUser.id ? messages.common.saving : messages.admin.forceResetPassword}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  const feedback = message ? <p className="text-sm text-[color:var(--text-secondary)]">{message}</p> : null;

  if (variant === "embedded") {
    return (
      <div className="space-y-4">
        {feedback}
        {membersSection}
        {createMemberModal}
        {resetPasswordModal}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {feedback}
      {membersSection}
      {createMemberModal}
      {resetPasswordModal}
    </div>
  );
}
