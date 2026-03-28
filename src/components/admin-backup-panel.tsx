"use client";

import { useMemo, useState } from "react";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { t } from "@/lib/i18n/messages";

type BackupPreview =
  | {
      kind: "users";
      schemaVersion: number;
      exportedAt: string;
    }
  | {
      kind: "conversations";
      schemaVersion: number;
      exportedAt: string;
      shardCount: number;
      shardMatches: number;
      totals: {
        sessions: number;
        messages: number;
        runs: number;
        runEvents: number;
      };
      ready: boolean;
    };

type ImportSummary = {
  kind: "users" | "conversations";
  schemaVersion: number;
  counts: Record<string, { created: number; updated: number }>;
  warnings: string[];
  normalizedRuns: number;
};

type ConversationExportJob = {
  files: Array<{
    fileName: string;
    kind: "manifest" | "shard";
    sizeBytes: number;
    downloadPath: string;
  }>;
  shardCount: number;
  warnings: string[];
};

function summarizeCounts(summary: ImportSummary, messages: Dictionary) {
  const entries = Object.entries(summary.counts).filter(
    ([, value]) => value.created > 0 || value.updated > 0,
  );

  if (entries.length === 0) {
    return messages.adminBackup.noDataChanged;
  }

  return entries
    .map(([key, value]) =>
      t(messages.adminBackup.countLine, {
        label: messages.adminBackup.countLabels[key as keyof typeof messages.adminBackup.countLabels] ?? key,
        created: value.created,
        updated: value.updated,
      }),
    )
    .join(" · ");
}

export function AdminBackupPanel({
  locale,
  messages,
  variant = "standalone",
}: {
  locale: Locale;
  messages: Dictionary;
  variant?: "standalone" | "embedded";
}) {
  const [busyKind, setBusyKind] = useState<"users" | "conversations" | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const previewDescription = useMemo(() => {
    if (!preview) {
      return null;
    }

    if (preview.kind === "users") {
      return t(messages.adminBackup.previewLine, {
        kind: messages.adminBackup.exportUsers,
        version: preview.schemaVersion,
        exportedAt: new Date(preview.exportedAt).toLocaleString(locale),
      });
    }

    return t(messages.adminBackup.previewShardLine, {
      kind: messages.adminBackup.exportConversations,
      version: preview.schemaVersion,
      exportedAt: new Date(preview.exportedAt).toLocaleString(locale),
      shardCount: preview.shardCount,
      shardMatches: preview.shardMatches,
      sessions: preview.totals.sessions,
    });
  }, [locale, messages.adminBackup, preview]);

  async function triggerDownload(downloadPath: string, fileName: string) {
    const response = await fetch(downloadPath, {
      headers: { [LOCALE_HEADER_NAME]: locale },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? messages.adminBackup.exportFailed);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportUsers() {
    const response = await fetch("/api/admin/backups/export?kind=users", {
      headers: { [LOCALE_HEADER_NAME]: locale },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? messages.adminBackup.exportFailed);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    const match = disposition?.match(/filename="(.+)"/);
    const fileName = match?.[1] ?? "mtc-backup-users.json";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportConversationShards() {
    const response = await fetch("/api/admin/backups/export/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [LOCALE_HEADER_NAME]: locale,
      },
      body: JSON.stringify({ kind: "conversations" }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? messages.adminBackup.exportFailed);
    }

    const payload = (await response.json()) as { job: ConversationExportJob };

    for (const [index, file] of payload.job.files.entries()) {
      setMessage(
        t(messages.adminBackup.exportDownloadProgress, {
          current: index + 1,
          total: payload.job.files.length,
          fileName: file.fileName,
        }),
      );
      await triggerDownload(file.downloadPath, file.fileName);
    }

    if (payload.job.warnings.length > 0) {
      setMessage(payload.job.warnings.join(" "));
    } else {
      setMessage(
        t(messages.adminBackup.exportConversationsShardSuccess, {
          count: payload.job.shardCount,
        }),
      );
    }
  }

  async function exportBackup(kind: "users" | "conversations") {
    setBusyKind(kind);
    setError(null);
    setMessage(null);

    try {
      if (kind === "users") {
        await exportUsers();
        setMessage(messages.adminBackup.exportUsersSuccess);
      } else {
        await exportConversationShards();
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : messages.adminBackup.exportFailed);
    } finally {
      setBusyKind(null);
    }
  }

  async function handleFileChange(inputFiles: File[]) {
    setSelectedFiles(inputFiles);
    setPreview(null);
    setSummary(null);
    setMessage(null);
    setError(null);

    if (inputFiles.length === 0) {
      return;
    }

    try {
      const parsedFiles = await Promise.all(
        inputFiles.map(async (file) => ({
          name: file.name,
          parsed: JSON.parse(await file.text()) as Record<string, unknown>,
        })),
      );

      const manifestCandidate = parsedFiles.find(
        (entry) =>
          entry.parsed.format === "mini-team-claw-backup" &&
          entry.parsed.kind === "conversations" &&
          entry.parsed.layout === "manifest",
      );

      if (manifestCandidate) {
        const shardEntries = Array.isArray(manifestCandidate.parsed.shards) ? manifestCandidate.parsed.shards : [];
        const expectedNames = new Set(
          shardEntries
            .map((entry) => (entry && typeof entry === "object" && "fileName" in entry ? String(entry.fileName) : ""))
            .filter(Boolean),
        );
        const matchedCount = inputFiles.filter((file) => expectedNames.has(file.name)).length;

        setPreview({
          kind: "conversations",
          schemaVersion: Number(manifestCandidate.parsed.schemaVersion),
          exportedAt: String(manifestCandidate.parsed.exportedAt),
          shardCount: Number(manifestCandidate.parsed.shardCount ?? 0),
          shardMatches: matchedCount,
          totals: {
            sessions: Number((manifestCandidate.parsed.totals as Record<string, unknown> | undefined)?.sessions ?? 0),
            messages: Number((manifestCandidate.parsed.totals as Record<string, unknown> | undefined)?.messages ?? 0),
            runs: Number((manifestCandidate.parsed.totals as Record<string, unknown> | undefined)?.runs ?? 0),
            runEvents: Number((manifestCandidate.parsed.totals as Record<string, unknown> | undefined)?.runEvents ?? 0),
          },
          ready: matchedCount === Number(manifestCandidate.parsed.shardCount ?? 0),
        });
        return;
      }

      if (parsedFiles.length !== 1) {
        throw new Error(messages.adminBackup.invalidPreview);
      }

      const parsed = parsedFiles[0]?.parsed;
      if (parsed?.format !== "mini-team-claw-backup") {
        throw new Error(messages.adminBackup.invalidPreview);
      }

      if (parsed.kind !== "users" && parsed.kind !== "conversations") {
        throw new Error(messages.adminBackup.invalidPreview);
      }

      if (typeof parsed.schemaVersion !== "number" || typeof parsed.exportedAt !== "string") {
        throw new Error(messages.adminBackup.invalidPreview);
      }

      if (parsed.kind === "users") {
        setPreview({
          kind: "users",
          schemaVersion: parsed.schemaVersion,
          exportedAt: parsed.exportedAt,
        });
      } else {
        setPreview({
          kind: "conversations",
          schemaVersion: parsed.schemaVersion,
          exportedAt: parsed.exportedAt,
          shardCount: 1,
          shardMatches: 1,
          totals: {
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions.length : 0,
            messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
            runs: Array.isArray(parsed.runs) ? parsed.runs.length : 0,
            runEvents: Array.isArray(parsed.runEvents) ? parsed.runEvents.length : 0,
          },
          ready: true,
        });
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : messages.adminBackup.invalidPreview);
    }
  }

  async function importBackup() {
    if (selectedFiles.length === 0) {
      setError(messages.adminBackup.fileRequired);
      return;
    }

    if (preview?.kind === "conversations" && !preview.ready) {
      setError(messages.adminBackup.missingShards);
      return;
    }

    setImporting(true);
    setError(null);
    setMessage(null);
    setSummary(null);

    try {
      const formData = new FormData();
      for (const file of selectedFiles) {
        formData.append("files", file);
      }

      const response = await fetch("/api/admin/backups/import", {
        method: "POST",
        headers: { [LOCALE_HEADER_NAME]: locale },
        body: formData,
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string; summary?: ImportSummary };
      if (!response.ok || !payload.summary) {
        throw new Error(payload.error ?? messages.adminBackup.importFailed);
      }

      setSummary(payload.summary);
      setMessage(messages.adminBackup.importSuccess);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : messages.adminBackup.importFailed);
    } finally {
      setImporting(false);
    }
  }

  const sectionClass = variant === "embedded" ? "ui-card-strong" : "ui-surface-muted";
  const content = (
    <>
      {variant === "standalone" ? (
        <header className="px-1">
          <p className="text-xs uppercase tracking-[0.3em] text-[color:var(--text-tertiary)]">
            {messages.adminBackup.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-[color:var(--text-primary)]">
            {messages.adminBackup.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-[color:var(--text-secondary)]">
            {messages.adminBackup.description}
          </p>
        </header>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className={`${sectionClass} rounded-2xl p-4`}>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.adminBackup.exportTitle}</p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.adminBackup.exportDescription}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void exportBackup("users")}
              disabled={busyKind !== null}
              className="ui-button-primary font-semibold disabled:cursor-not-allowed"
            >
              {busyKind === "users" ? messages.common.loading : messages.adminBackup.exportUsers}
            </button>
            <button
              type="button"
              onClick={() => void exportBackup("conversations")}
              disabled={busyKind !== null}
              className="ui-button-secondary font-medium disabled:cursor-not-allowed"
            >
              {busyKind === "conversations" ? messages.common.loading : messages.adminBackup.exportConversations}
            </button>
          </div>
          <p className="mt-3 text-sm text-[color:var(--text-quaternary)]">
            {messages.adminBackup.exportConversationShardsHint}
          </p>
        </div>

        <div className={`${sectionClass} rounded-2xl p-4`}>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.adminBackup.importTitle}</p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{messages.adminBackup.importDescription}</p>
          <label className="ui-file-trigger mt-4 w-full">
            <input
              type="file"
              multiple
              accept="application/json,.json"
              onChange={(event) => void handleFileChange(Array.from(event.target.files ?? []))}
              className="sr-only"
            />
            <span>{messages.adminBackup.importAction}</span>
          </label>
          {previewDescription ? (
            <p className="mt-3 text-sm text-[color:var(--text-secondary)]">{previewDescription}</p>
          ) : (
            <p className="mt-3 text-sm text-[color:var(--text-quaternary)]">{messages.adminBackup.importHint}</p>
          )}
          {selectedFiles.length > 0 ? (
            <p className="mt-2 text-sm text-[color:var(--text-quaternary)]">
              {t(messages.adminBackup.selectedFiles, { count: selectedFiles.length })}
            </p>
          ) : null}
          {preview?.kind === "conversations" ? (
            <p className="mt-2 text-sm text-[color:var(--text-quaternary)]">
              {preview.ready
                ? t(messages.adminBackup.shardsReady, { count: preview.shardCount })
                : t(messages.adminBackup.shardsMissing, {
                    ready: preview.shardMatches,
                    total: preview.shardCount,
                  })}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void importBackup()}
            disabled={selectedFiles.length === 0 || importing || (preview?.kind === "conversations" && !preview.ready)}
            className="ui-button-primary mt-4 font-semibold disabled:cursor-not-allowed"
          >
            {importing ? messages.common.loading : messages.adminBackup.importAction}
          </button>
        </div>
      </div>

      {message ? <p className="mt-4 text-sm text-[color:var(--accent-strong)]">{message}</p> : null}
      {error ? <p className="mt-4 text-sm text-[color:var(--danger-strong)]">{error}</p> : null}

      {summary ? (
        <div className={`${sectionClass} mt-4 rounded-2xl p-4`}>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">{messages.adminBackup.importSummary}</p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
            {t(messages.adminBackup.summaryHeader, {
              kind: summary.kind === "users" ? messages.adminBackup.exportUsers : messages.adminBackup.exportConversations,
              version: summary.schemaVersion,
            })}
          </p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">{summarizeCounts(summary, messages)}</p>
          {summary.normalizedRuns > 0 ? (
            <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
              {t(messages.adminBackup.normalizedRuns, { count: summary.normalizedRuns })}
            </p>
          ) : null}
          {summary.warnings.map((warning, index) => (
            <p key={`${warning}-${index}`} className="mt-2 text-sm text-[color:var(--text-secondary)]">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      {busyKind === "conversations" ? (
        <div className={`${sectionClass} mt-4 rounded-2xl p-4`}>
          <p className="text-sm font-medium text-[color:var(--text-primary)]">
            {messages.adminBackup.downloadFilesTitle}
          </p>
          <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
            {messages.adminBackup.downloadFilesDescription}
          </p>
        </div>
      ) : null}
    </>
  );

  if (variant === "embedded") {
    return <div>{content}</div>;
  }

  return (
    <section className="ui-card rounded-[2rem] p-5">
      {content}
    </section>
  );
}
