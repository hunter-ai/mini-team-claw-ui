"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { localizeHref } from "@/lib/i18n/routing";
import type { SetupStatus } from "@/lib/setup";
import { normalizeOpenClawAgentId } from "@/lib/user-form";

function gatewayStatusText(messages: Dictionary, status: SetupStatus["gatewayStatus"]) {
  switch (status) {
    case "healthy":
      return messages.setup.gatewayHealthy;
    case "pairing_required":
      return messages.setup.gatewayPairingRequired;
    case "auth_failed":
      return messages.setup.gatewayAuthFailed;
    case "unreachable":
      return messages.setup.gatewayUnreachable;
    case "invalid_config":
      return messages.setup.gatewayInvalidConfig;
    default:
      return messages.setup.gatewayUntested;
  }
}

function formatDate(value: string | null, locale: Locale) {
  if (!value) {
    return "—";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function SystemSetupPanel({
  locale,
  messages,
  initialStatus,
  mode,
}: {
  locale: Locale;
  messages: Dictionary;
  initialStatus: SetupStatus;
  mode: "setup" | "admin";
}) {
  const [status, setStatus] = useState(initialStatus);
  const [currentOrigin, setCurrentOrigin] = useState("");
  const [runtimeForm, setRuntimeForm] = useState({
    gatewayUrl: initialStatus.runtimeConfig?.gatewayUrl ?? "",
    gatewayAuthMode: initialStatus.runtimeConfig?.gatewayAuthMode ?? "token",
    gatewayToken: "",
    gatewayPassword: "",
    appUrl: initialStatus.runtimeConfig?.appUrl ?? "",
  });
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [runtimeDiagnostic, setRuntimeDiagnostic] = useState<string | null>(null);
  const [gatewayMessage, setGatewayMessage] = useState<string | null>(null);
  const [gatewayDiagnostic, setGatewayDiagnostic] = useState<string | null>(null);
  const [resettingDeviceToken, setResettingDeviceToken] = useState(false);
  const [resetDeviceDialogOpen, setResetDeviceDialogOpen] = useState(false);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [adminDiagnostic, setAdminDiagnostic] = useState<string | null>(null);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [testingGateway, setTestingGateway] = useState(false);
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [adminForm, setAdminForm] = useState({
    username: "",
    password: "",
    openclawAgentId: "main",
  });

  useEffect(() => {
    setCurrentOrigin(window.location.origin);
  }, []);

  async function localeFetch(input: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set(LOCALE_HEADER_NAME, locale);
    return fetch(input, { ...init, headers });
  }

  async function refreshStatus() {
    const response = await localeFetch("/api/setup/status", { cache: "no-store" });
    const payload = (await response.json()) as SetupStatus;
    setStatus(payload);
    setRuntimeForm((current) => ({
      gatewayUrl: payload.runtimeConfig?.gatewayUrl ?? current.gatewayUrl,
      gatewayAuthMode: payload.runtimeConfig?.gatewayAuthMode ?? current.gatewayAuthMode,
      gatewayToken: "",
      gatewayPassword: "",
      appUrl: payload.runtimeConfig?.appUrl ?? "",
    }));
    return payload;
  }

  async function saveRuntimeConfig(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRuntime(true);
    setRuntimeMessage(null);
    setRuntimeDiagnostic(null);

    try {
      const response = await localeFetch("/api/setup/runtime-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
        body: JSON.stringify({
          gatewayUrl: runtimeForm.gatewayUrl,
          gatewayAuthMode: runtimeForm.gatewayAuthMode,
          gatewayToken: runtimeForm.gatewayToken,
          gatewayPassword: runtimeForm.gatewayPassword,
          appUrl: runtimeForm.appUrl,
          preserveGatewayCredential:
            gatewayCredentialConfigured &&
            !(runtimeForm.gatewayAuthMode === "password"
              ? runtimeForm.gatewayPassword.trim()
              : runtimeForm.gatewayToken.trim()),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        errorDiagnostic?: string;
      };
      if (!response.ok) {
        setRuntimeMessage(payload.error ?? messages.setup.runtimeConfigSaveFailed);
        setRuntimeDiagnostic(payload.errorDiagnostic ?? null);
        return;
      }

      await refreshStatus();
      setRuntimeMessage(messages.setup.runtimeConfigSaved);
    } finally {
      setSavingRuntime(false);
    }
  }

  async function runGatewayTest() {
    setTestingGateway(true);
    setGatewayMessage(null);
    setGatewayDiagnostic(null);

    try {
      const response = await localeFetch("/api/setup/gateway/test", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: SetupStatus["gatewayStatus"];
        message?: string;
        errorDiagnostic?: string;
      };

      await refreshStatus();
      setGatewayMessage(
        payload.message ??
          (payload.status ? gatewayStatusText(messages, payload.status) : messages.setup.gatewayTestFailed),
      );
      setGatewayDiagnostic(payload.errorDiagnostic ?? null);
    } finally {
      setTestingGateway(false);
    }
  }

  async function resetGatewayDeviceToken() {
    setResettingDeviceToken(true);
    setGatewayMessage(null);
    setGatewayDiagnostic(null);

    try {
      const response = await localeFetch("/api/setup/gateway/reset-device-token", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: SetupStatus["gatewayStatus"];
        message?: string;
        errorDiagnostic?: string;
      };

      await refreshStatus();
      setGatewayMessage(
        payload.message ??
          (payload.status === "pairing_required"
            ? messages.setup.gatewayDeviceResetPendingApproval
            : payload.status === "healthy"
              ? messages.setup.gatewayDeviceResetSucceeded
              : payload.status
                ? gatewayStatusText(messages, payload.status)
                : messages.setup.gatewayDeviceResetFailed),
      );
      setGatewayDiagnostic(payload.errorDiagnostic ?? null);
      setResetDeviceDialogOpen(false);
    } finally {
      setResettingDeviceToken(false);
    }
  }

  async function createFirstAdmin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingAdmin(true);
    setAdminMessage(null);
    setAdminDiagnostic(null);

    try {
      const response = await localeFetch("/api/setup/first-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", [LOCALE_HEADER_NAME]: locale },
        body: JSON.stringify(adminForm),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        errorDiagnostic?: string;
      };
      if (!response.ok) {
        setAdminMessage(payload.error ?? messages.setup.firstAdminCreateFailed);
        setAdminDiagnostic(payload.errorDiagnostic ?? null);
        return;
      }

      setAdminForm({ username: "", password: "", openclawAgentId: "main" });
      const refreshed = await refreshStatus();
      setAdminMessage(messages.setup.firstAdminCreated);
      if (refreshed.isComplete && mode === "setup") {
        window.location.href = loginHref;
      }
    } finally {
      setCreatingAdmin(false);
    }
  }

  const loginHref = localizeHref(locale, "/login");
  const usesSeedBootstrap = status.adminBootstrapMode === "seed";
  const gatewayCredentialConfigured =
    runtimeForm.gatewayAuthMode === "password"
      ? status.runtimeConfig?.gatewayPasswordConfigured === true
      : status.runtimeConfig?.gatewayTokenConfigured === true;
  const gatewaySecretLabel =
    runtimeForm.gatewayAuthMode === "password" ? messages.setup.gatewayPassword : messages.setup.gatewayToken;
  const gatewaySecretPlaceholder =
    runtimeForm.gatewayAuthMode === "password"
      ? messages.setup.gatewayPasswordPlaceholder
      : messages.setup.gatewayTokenPlaceholder;
  const gatewaySecretHint =
    runtimeForm.gatewayAuthMode === "password"
      ? messages.setup.gatewayPasswordHint
      : messages.setup.gatewayTokenHint;
  const gatewaySecretValue =
    runtimeForm.gatewayAuthMode === "password" ? runtimeForm.gatewayPassword : runtimeForm.gatewayToken;
  const canResetDeviceAuthorization = status.gatewayRemediation?.action === "reset_device_token";

  const resetDeviceDialog = resetDeviceDialogOpen ? (
    <div className="ui-overlay fixed inset-0 z-40 flex items-end justify-center px-4 py-4 sm:items-center">
      <button
        type="button"
        aria-label={messages.common.cancel}
        onClick={() => {
          if (!resettingDeviceToken) {
            setResetDeviceDialogOpen(false);
          }
        }}
        className="absolute inset-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-device-token-modal-title"
        className="ui-card ui-dialog relative z-10 w-full max-w-md"
      >
        <div className="mb-4">
          <p id="reset-device-token-modal-title" className="text-sm font-semibold text-[color:var(--text-primary)]">
            {messages.setup.gatewayDeviceResetConfirmTitle}
          </p>
          <p className="ui-field-note mt-1">{messages.setup.gatewayDeviceResetConfirmDescription}</p>
        </div>
        <div className="ui-dialog-actions">
          <button
            type="button"
            onClick={() => setResetDeviceDialogOpen(false)}
            disabled={resettingDeviceToken}
            className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
          >
            {messages.common.cancel}
          </button>
          <button
            type="button"
            onClick={() => void resetGatewayDeviceToken()}
            disabled={resettingDeviceToken}
            className="ui-button-primary ui-button-chip font-semibold disabled:cursor-not-allowed"
          >
            {resettingDeviceToken ? messages.common.loading : messages.setup.gatewayDeviceResetConfirmAction}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      {mode === "setup" ? (
        <section className="ui-card rounded-[2rem] p-6 sm:p-7">
          <p className="text-[11px] uppercase tracking-[0.32em] text-[color:var(--text-tertiary)]">
            {messages.setup.eyebrow}
          </p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-[color:var(--text-primary)] sm:text-[2.4rem]">
            {messages.setup.title}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--text-secondary)]">
            {messages.setup.description}
          </p>
          <div className="mt-6 flex flex-col gap-2.5 text-sm text-[color:var(--text-secondary)] sm:flex-row sm:flex-wrap sm:gap-3">
            {[
              messages.setup.stepConnect,
              messages.setup.stepVerify,
              ...(usesSeedBootstrap ? [] : [messages.setup.stepAdmin]),
            ].map((step, index) => (
              <div key={step} className="flex min-h-[var(--touch-target-min)] items-center gap-2 rounded-full bg-[color:var(--surface-subtle)] px-3.5 py-2.5">
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-[color:var(--surface-contrast)] text-[10px] font-semibold text-[color:var(--text-inverse)]">
                  {index + 1}
                </span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ui-card rounded-[2rem] p-5">
        <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
          {messages.setup.environmentTitle}
        </p>
        <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.setup.environmentDescription}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.databaseReady}</p>
            <p className="ui-field-note mt-1 text-[color:var(--text-secondary)]">
              {status.envDiagnostics.databaseConfigured ? messages.setup.stateReady : messages.setup.stateMissing}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.sessionSecretReady}</p>
            <p className="ui-field-note mt-1 text-[color:var(--text-secondary)]">
              {status.envDiagnostics.sessionSecretConfigured ? messages.setup.stateReady : messages.setup.stateMissing}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.uploadContainer}</p>
            <p className="ui-field-note mt-1 break-all text-[color:var(--text-secondary)]">
              {status.envDiagnostics.attachmentsFileAccessRoot}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.uploadHost}</p>
            <p className="ui-field-note mt-1 break-all text-[color:var(--text-secondary)]">
              {status.envDiagnostics.attachmentsMessagePathRoot}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.maxUploadBytes}</p>
            <p className="ui-field-note mt-1 text-[color:var(--text-secondary)]">
              {String(status.envDiagnostics.maxUploadBytes)}
            </p>
          </div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.verboseLevel}</p>
            <p className="ui-field-note mt-1 text-[color:var(--text-secondary)]">
              {status.envDiagnostics.verboseLevel}
            </p>
          </div>
        </div>
      </section>

      <section className="ui-card rounded-[2rem] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
              {messages.setup.runtimeTitle}
            </p>
            <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
              {messages.setup.runtimeDescription}
            </p>
          </div>
        </div>

        <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={saveRuntimeConfig}>
          <label className="space-y-2.5 md:col-span-2">
            <span className="text-sm font-medium">{messages.setup.gatewayUrl}</span>
            <input
              value={runtimeForm.gatewayUrl}
              onChange={(event) =>
                setRuntimeForm((current) => ({ ...current, gatewayUrl: event.target.value }))
              }
              className="ui-input"
              required
            />
            <p className="ui-field-note">{messages.setup.gatewayUrlHint}</p>
          </label>
          <label className="space-y-2.5">
            <span className="text-sm font-medium">{messages.setup.gatewayAuthMode}</span>
            <select
              value={runtimeForm.gatewayAuthMode}
              onChange={(event) =>
                setRuntimeForm((current) => ({
                  ...current,
                  gatewayAuthMode: event.target.value as "token" | "password",
                }))
              }
              className="ui-input"
            >
              <option value="token">{messages.setup.gatewayAuthModeToken}</option>
              <option value="password">{messages.setup.gatewayAuthModePassword}</option>
            </select>
            <p className="ui-field-note">{messages.setup.gatewayAuthModeHint}</p>
          </label>
          <label className="space-y-2.5">
            <span className="text-sm font-medium">{gatewaySecretLabel}</span>
            <input
              type="password"
              value={gatewaySecretValue}
              onChange={(event) => {
                const nextValue = event.target.value;
                setRuntimeForm((current) =>
                  current.gatewayAuthMode === "password"
                    ? { ...current, gatewayPassword: nextValue }
                    : { ...current, gatewayToken: nextValue },
                );
              }}
              className="ui-input"
              placeholder={gatewaySecretPlaceholder}
              required={!gatewayCredentialConfigured}
            />
            <p className="ui-field-note">{gatewaySecretHint}</p>
          </label>
          <label className="space-y-2.5">
            <span className="text-sm font-medium">{messages.setup.appUrl}</span>
            <input
              value={runtimeForm.appUrl}
              onChange={(event) => setRuntimeForm((current) => ({ ...current, appUrl: event.target.value }))}
              className="ui-input"
              placeholder={messages.setup.appUrlPlaceholder}
            />
            <p className="ui-field-note">{messages.setup.appUrlHint}</p>
            <button
              type="button"
              onClick={() => setRuntimeForm((current) => ({ ...current, appUrl: currentOrigin }))}
              disabled={!currentOrigin}
              className="ui-button-secondary ui-button-chip inline-flex font-medium"
            >
              {messages.setup.fillCurrentOrigin}
            </button>
          </label>
          <button
            type="submit"
            disabled={savingRuntime}
            className="ui-button-primary font-semibold md:col-span-2"
          >
            {savingRuntime ? messages.common.saving : messages.setup.saveRuntimeConfig}
          </button>
        </form>
        {runtimeMessage ? (
          <div className="mt-3 space-y-1">
            <p className="text-sm text-[color:var(--text-secondary)]">{runtimeMessage}</p>
            {runtimeDiagnostic ? (
              <p className="text-xs text-[color:var(--text-quaternary)]">
                {messages.common.diagnosticLabel}: {runtimeDiagnostic}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="ui-card rounded-[2rem] p-5">
        <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
          {messages.setup.gatewayTitle}
        </p>
        <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.setup.gatewayDescription}</p>

        <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
          <p className="text-sm font-medium text-[color:var(--text-primary)]">
            {gatewayStatusText(messages, status.gatewayStatus)}
          </p>
          {gatewayMessage ? (
            <div className="mt-2 space-y-1">
              <p className="text-sm text-[color:var(--text-secondary)]">{gatewayMessage}</p>
              {gatewayDiagnostic ? (
                <p className="text-xs text-[color:var(--text-quaternary)]">
                  {messages.common.diagnosticLabel}: {gatewayDiagnostic}
                </p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={runGatewayTest}
            disabled={testingGateway || resettingDeviceToken}
            className="ui-button-secondary ui-button-chip mt-4 font-medium"
          >
            {testingGateway
              ? messages.common.loading
              : status.gatewayStatus === "pairing_required"
                ? messages.setup.gatewayRetestAction
                : messages.setup.gatewayTestAction}
          </button>
        </div>

        {canResetDeviceAuthorization ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.gatewayDeviceResetTitle}</p>
            <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.setup.gatewayDeviceResetDescription}</p>
            <button
              type="button"
              onClick={() => setResetDeviceDialogOpen(true)}
              disabled={testingGateway || resettingDeviceToken}
              className="ui-button-secondary ui-button-chip mt-4 font-medium disabled:cursor-not-allowed"
            >
              {resettingDeviceToken ? messages.common.loading : messages.setup.gatewayDeviceResetAction}
            </button>
          </div>
        ) : null}

        {status.pairing ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.setup.openclawApprovalHint}</p>
            <p className="mt-3 text-sm text-[color:var(--text-secondary)]">
              {messages.setup.pendingRequestId}: {status.pairing.pendingRequests[0]?.requestId ?? "—"}
            </p>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
              {messages.setup.pendingRequestedAt}: {formatDate(status.pairing.pendingRequests[0]?.requestedAt ?? null, locale)}
            </p>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
              {messages.setup.pendingScopes}:{" "}
              {status.pairing.pendingRequests[0]?.scopes.join(", ") || "—"}
            </p>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
              {messages.setup.pendingClient}:{" "}
              {[
                status.pairing.pendingRequests[0]?.clientId,
                status.pairing.pendingRequests[0]?.clientMode,
                status.pairing.pendingRequests[0]?.clientPlatform,
              ]
                .filter(Boolean)
                .join(" / ") || "—"}
            </p>
            <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-white/70 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--text-tertiary)]">
                {messages.setup.openclawApprovalCommands}
              </p>
              <pre className="mt-3 overflow-x-auto text-xs leading-6 text-[color:var(--text-secondary)]">
{`openclaw devices list
openclaw devices approve ${status.pairing.pendingRequests[0]?.requestId ?? "<requestId>"}`}
              </pre>
            </div>
          </div>
        ) : null}
      </section>

      <section className="ui-card rounded-[2rem] p-5">
        <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
          {messages.setup.adminTitle}
        </p>
        <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.setup.adminDescription}</p>

        {usesSeedBootstrap ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm text-[color:var(--text-secondary)]">
              {status.hasActiveAdmin ? messages.setup.firstAdminExists : messages.setup.firstAdminMissing}
            </p>
            {mode === "setup" && status.isComplete ? (
              <Link href={loginHref} className="ui-button-primary ui-button-chip mt-4 inline-flex font-semibold">
                {messages.setup.goToLogin}
              </Link>
            ) : null}
          </div>
        ) : status.hasActiveAdmin ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-4 py-4">
            <p className="text-sm text-[color:var(--text-secondary)]">{messages.setup.firstAdminExists}</p>
            {mode === "setup" && status.isComplete ? (
              <Link href={loginHref} className="ui-button-primary ui-button-chip mt-4 inline-flex font-semibold">
                {messages.setup.goToLogin}
              </Link>
            ) : null}
          </div>
        ) : (
          <form className="mt-5 grid gap-4 md:grid-cols-3" onSubmit={createFirstAdmin}>
            <div className="space-y-1.5">
              <input
                value={adminForm.username}
                onChange={(event) =>
                  setAdminForm((current) => ({ ...current, username: event.target.value }))
                }
                className="ui-input"
                placeholder={messages.setup.username}
                required
              />
              <p className="ui-field-note">{messages.setup.usernameHint}</p>
            </div>
            <div className="space-y-1.5">
              <input
                type="password"
                value={adminForm.password}
                onChange={(event) =>
                  setAdminForm((current) => ({ ...current, password: event.target.value }))
                }
                className="ui-input"
                placeholder={messages.setup.password}
                required
              />
              <p className="ui-field-note">{messages.setup.passwordHint}</p>
            </div>
            <div className="space-y-1.5">
              <input
                value={adminForm.openclawAgentId}
                onChange={(event) => {
                  const value = event.target.value;
                  setAdminForm((current) => ({ ...current, openclawAgentId: value }));
                }}
                onBlur={(event) => {
                  const normalized = normalizeOpenClawAgentId(event.target.value);
                  setAdminForm((current) => ({ ...current, openclawAgentId: normalized || "main" }));
                }}
                className="ui-input"
                placeholder={messages.setup.agentId}
                required
              />
              <p className="ui-field-note">{messages.setup.agentIdHint}</p>
            </div>
            <button
              type="submit"
              disabled={creatingAdmin}
              className="ui-button-primary font-semibold md:col-span-3"
            >
              {creatingAdmin ? messages.common.saving : messages.setup.createFirstAdmin}
            </button>
          </form>
        )}
        {adminMessage ? (
          <div className="mt-3 space-y-1">
            <p className="text-sm text-[color:var(--text-secondary)]">{adminMessage}</p>
            {adminDiagnostic ? (
              <p className="text-xs text-[color:var(--text-quaternary)]">
                {messages.common.diagnosticLabel}: {adminDiagnostic}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      {resetDeviceDialog}
    </div>
  );
}
