"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { memo } from "react";
import { UserRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { v4 as uuidv4 } from "uuid";
import type {
  ClientAssistantRenderMode,
  ClientChatRunEvent,
  ClientRunActivityEntry,
  ClientRunHistoryItem,
} from "@/lib/chat-run-events";
import { LazycatFilePickerBridge } from "@/components/lazycat-file-picker-bridge";
import { LanguageSwitcher } from "@/components/language-switcher";
import { formatRelativeDate } from "@/lib/utils";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getLifecycleTitle, t } from "@/lib/i18n/messages";
import { localizeHref } from "@/lib/i18n/routing";
import { LogoutButton } from "@/components/logout-button";
import type { SessionContextUsage } from "@/lib/session-context-usage";
import { OPENCLAW_SLASH_COMMANDS, type SlashCommandDefinition } from "@/lib/slash-commands";
import { CodeBlock } from "@/components/code-block";
import type { LazycatPickerSubmitDetail } from "@/lib/lazycat-attachments";

type Attachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
};

type SelectedSkill = {
  key: string;
  name: string;
  source: string;
  bundled: boolean;
};

type SkillInstallItem = {
  id: string;
  kind: string;
  label: string;
  bins: string[];
};

type Skill = {
  key: string;
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  install: SkillInstallItem[];
};

type Message = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
  skills: SelectedSkill[];
  attachments: Attachment[];
};

type SessionRun = {
  id: string;
  status: "STARTING" | "STREAMING" | "COMPLETED" | "FAILED" | "ABORTED";
  clientRequestId: string;
  assistantMessageId: string | null;
  lastEventSeq: number;
  draftAssistantContent: string;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
};

type SessionErrorState = {
  message: string;
  diagnostic: string | null;
};

type Session = {
  id: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
  lastMessageAt: string | null;
  activeRun: SessionRun | null;
};

type SessionShare = {
  enabled: boolean;
  shareUrl: string | null;
  accessMode: "PUBLIC" | "PASSWORD" | null;
  snapshotUpdatedAt: string | null;
};

type PairingState = {
  status: "pairing_required";
  message: string;
  diagnostic: string | null;
  deviceId: string | null;
  lastPairedAt: string | null;
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

type UserShape = {
  username: string;
  role: UserRole;
  openclawAgentId: string;
};

type SessionsPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

type ComposerMode = "active-session" | "bootstrap" | "create-session-only";

type RunState = "idle" | "starting" | "streaming" | "reconnecting" | "failed" | "aborted" | "completed";
type StreamPayload = ClientChatRunEvent | { type: "ping"; runId: string; seq: null };
type BufferedRunPatch = {
  runId: string;
  draftAssistantContent: string;
  lastEventSeq: number;
  updatedAt: string;
};

type SessionContextUsageState = {
  status: "idle" | "ok" | "unavailable" | "pairing_required";
  usage: SessionContextUsage | null;
};

type ComposerSelection = {
  start: number;
  end: number;
};

type SlashSuggestionItem =
  | {
      kind: "openclaw-command";
      key: string;
      label: string;
      description: string;
      aliases: string[];
      argumentHint?: string;
      insertText: string;
      searchTerms: string[];
    }
  | {
      kind: "skill";
      key: string;
      label: string;
      description: string;
      skill: Skill;
      searchTerms: string[];
    };

type ActiveSlashMatch = {
  lineStart: number;
  slashStart: number;
  tokenEnd: number;
  query: string;
  commandName: string;
  argsText: string;
  isCursorInCommandToken: boolean;
  dismissKey: string;
};

type RenderableMessage =
  | {
      kind: "message";
      id: string;
      message: Message;
      run: ClientRunHistoryItem | null;
    }
  | {
      kind: "synthetic-run";
      id: string;
      run: ClientRunHistoryItem;
    };

type RunContentSegmentation = {
  segments: string[];
  stepKeys: string[];
  capturedTextLength: number;
};

type AssistantRenderBlock =
  | {
      kind: "markdown_text";
      key: string;
      content: string;
      renderMode: ClientAssistantRenderMode;
      streaming?: boolean;
    }
  | {
      kind: "tool_step";
      key: string;
      entry: Extract<ClientRunActivityEntry, { kind: "tool" }>;
      streaming?: boolean;
    }
  | {
      kind: "lifecycle_note";
      key: string;
      entry: Extract<ClientRunActivityEntry, { kind: "lifecycle" }>;
      streaming?: boolean;
    };

const SESSION_TITLE_MAX_LENGTH = 60;

function normalizeSlashSearchTerm(value: string) {
  return value.trim().toLowerCase().replace(/^\//, "");
}

function getSlashLineStart(text: string, cursor: number) {
  return text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function parseActiveSlashMatch(text: string, selectionStart: number, selectionEnd: number): ActiveSlashMatch | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const lineStart = getSlashLineStart(text, selectionStart);
  const lineBeforeCursor = text.slice(lineStart, selectionStart);
  const leadingWhitespace = lineBeforeCursor.match(/^\s*/)?.[0].length ?? 0;
  const trimmedBeforeCursor = lineBeforeCursor.slice(leadingWhitespace);

  if (!trimmedBeforeCursor.startsWith("/")) {
    return null;
  }

  const slashStart = lineStart + leadingWhitespace;
  const lineEndIndex = text.indexOf("\n", slashStart);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const lineContent = text.slice(slashStart, lineEnd);
  const tokenMatch = lineContent.match(/^\/([^\s]*)/);

  if (!tokenMatch) {
    return null;
  }

  const commandName = tokenMatch[1];
  const tokenEnd = slashStart + tokenMatch[0].length;

  return {
    lineStart,
    slashStart,
    tokenEnd,
    query: commandName,
    commandName,
    argsText: lineContent.slice(tokenMatch[0].length).trimStart(),
    isCursorInCommandToken: selectionStart <= tokenEnd,
    dismissKey: `${slashStart}:${lineContent}`,
  };
}

function scoreSlashSuggestion(query: string, item: SlashSuggestionItem) {
  if (!query) {
    return item.kind === "openclaw-command" ? 0 : 1;
  }

  let bestScore = Number.POSITIVE_INFINITY;
  for (const searchTerm of item.searchTerms) {
    if (searchTerm === query) {
      bestScore = Math.min(bestScore, 0);
      continue;
    }
    if (searchTerm.startsWith(query)) {
      bestScore = Math.min(bestScore, 1);
      continue;
    }
    const includesIndex = searchTerm.indexOf(query);
    if (includesIndex !== -1) {
      bestScore = Math.min(bestScore, 20 + includesIndex);
    }
  }

  return bestScore;
}

function buildSlashSuggestions(args: {
  query: string;
  sortedSkills: Skill[];
  commands: SlashCommandDefinition[];
}) {
  const normalizedQuery = normalizeSlashSearchTerm(args.query);
  const suggestions: Array<SlashSuggestionItem & { score: number }> = [];

  for (const command of args.commands) {
    const item: SlashSuggestionItem = {
      kind: "openclaw-command",
      key: command.key,
      label: command.label,
      description: command.description,
      aliases: command.aliases,
      argumentHint: command.argumentHint,
      insertText: command.insertText,
      searchTerms: [
        normalizeSlashSearchTerm(command.key),
        normalizeSlashSearchTerm(command.label),
        ...command.aliases.map(normalizeSlashSearchTerm),
      ],
    };
    const score = scoreSlashSuggestion(normalizedQuery, item);
    if (score !== Number.POSITIVE_INFINITY) {
      suggestions.push({ ...item, score });
    }
  }

  for (const skill of args.sortedSkills) {
    const item: SlashSuggestionItem = {
      kind: "skill",
      key: skill.key,
      label: skill.name,
      description: skill.description,
      skill,
      searchTerms: [
        normalizeSlashSearchTerm(skill.key),
        normalizeSlashSearchTerm(skill.name),
        ...skill.name.split(/\s+/).map(normalizeSlashSearchTerm),
      ],
    };
    const score = scoreSlashSuggestion(normalizedQuery, item);
    if (score !== Number.POSITIVE_INFINITY) {
      suggestions.push({ ...item, score });
    }
  }

  return suggestions
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.kind !== right.kind) {
        return left.kind === "openclaw-command" ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    })
    .map((entry) => {
      const { score, ...item } = entry;
      void score;
      return item;
    });
}

function replaceComposerRange(text: string, start: number, end: number, nextText: string) {
  return `${text.slice(0, start)}${nextText}${text.slice(end)}`;
}

function logChatShellDebug(message: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug(message, details);
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function normalizeUploadFiles(files: FileList | File[] | Iterable<File> | null | undefined) {
  if (!files) {
    return [];
  }

  if (files instanceof FileList) {
    return Array.from(files);
  }

  if (Array.isArray(files)) {
    return files;
  }

  return Array.from(files);
}

function compareSkills(left: Skill, right: Skill) {
  if (left.eligible !== right.eligible) {
    return left.eligible ? -1 : 1;
  }

  const leftPersonal = left.source === "agents-skills-personal";
  const rightPersonal = right.source === "agents-skills-personal";
  if (leftPersonal !== rightPersonal) {
    return leftPersonal ? -1 : 1;
  }

  if (left.bundled !== right.bundled) {
    return left.bundled ? -1 : 1;
  }

  return left.name.localeCompare(right.name, "en");
}

function getSkillStatus(messages: Dictionary, skill: Skill) {
  if (skill.disabled) {
    return messages.chat.skillDisabled;
  }

  if (skill.blockedByAllowlist) {
    return messages.chat.skillBlocked;
  }

  if (!skill.eligible) {
    return messages.chat.skillMissing;
  }

  return messages.chat.skillAvailable;
}

function mapRunStatusToState(status: SessionRun["status"] | undefined | null): RunState {
  switch (status) {
    case "STARTING":
      return "starting";
    case "STREAMING":
      return "streaming";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "ABORTED":
      return "aborted";
    default:
      return "idle";
  }
}

function isActiveSessionRunStatus(status: SessionRun["status"] | undefined | null) {
  return status === "STARTING" || status === "STREAMING";
}

function isRunBusy(state: RunState) {
  return state === "starting" || state === "streaming" || state === "reconnecting";
}

function parseSsePayload(input: string) {
  return JSON.parse(input) as StreamPayload;
}

function truncateText(value: string, maxLength = 240) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function normalizeDiagnostic(message: string | null | undefined, diagnostic: string | null | undefined) {
  if (!diagnostic) {
    return null;
  }

  return diagnostic.trim() === (message ?? "").trim() ? null : diagnostic;
}

function createSessionErrorState(
  message: string | null | undefined,
  diagnostic?: string | null,
): SessionErrorState | null {
  if (!message) {
    return null;
  }

  return {
    message,
    diagnostic: normalizeDiagnostic(message, diagnostic),
  };
}

function getActivityEntryRenderKey(entry: ClientRunActivityEntry) {
  if (entry.kind === "tool") {
    return entry.tool.callId ?? entry.tool.key ?? entry.key;
  }

  return entry.key;
}

function shouldRenderLifecycleEntry(entry: Extract<ClientRunActivityEntry, { kind: "lifecycle" }>) {
  return !["started", "completed"].includes(entry.phase);
}

function summarizeRenderableSteps(run: ClientRunHistoryItem | null) {
  if (!run) {
    return [];
  }

  const toolGroups = new Map<
    string,
    {
      sortSeq: number;
      entry: Extract<ClientRunActivityEntry, { kind: "tool" }>;
    }
  >();
  const lifecycleEntries: Array<{
    sortSeq: number;
    entry: Extract<ClientRunActivityEntry, { kind: "lifecycle" }>;
  }> = [];

  for (const step of run.steps) {
    if (step.kind === "tool") {
      const key = getActivityEntryRenderKey(step);
      const existing = toolGroups.get(key);

      if (!existing) {
        toolGroups.set(key, {
          sortSeq: step.seq,
          entry: step,
        });
        continue;
      }

      toolGroups.set(key, {
        sortSeq: existing.sortSeq,
        entry: {
          ...existing.entry,
          ...step,
          tool: {
            ...existing.entry.tool,
            ...step.tool,
          },
        },
      });
      continue;
    }

    if (shouldRenderLifecycleEntry(step)) {
      lifecycleEntries.push({
        sortSeq: step.seq,
        entry: step,
      });
    }
  }

  return [
    ...Array.from(toolGroups.values()),
    ...lifecycleEntries,
  ]
    .sort((left, right) => left.sortSeq - right.sortSeq)
    .map((item) => item.entry);
}

function updateRunSegmentation(
  current: Record<string, RunContentSegmentation>,
  runId: string,
  fullText: string,
  stepKey: string,
) {
  const existing = current[runId] ?? {
    segments: [],
    stepKeys: [],
    capturedTextLength: 0,
  };

  if (existing.stepKeys.includes(stepKey)) {
    return current;
  }

  const nextSegments = [...existing.segments];
  const nextText = fullText.slice(existing.capturedTextLength);
  if (nextText.length > 0) {
    nextSegments.push(nextText);
  } else {
    nextSegments.push("");
  }

  return {
    ...current,
    [runId]: {
      segments: nextSegments,
      stepKeys: [...existing.stepKeys, stepKey],
      capturedTextLength: fullText.length,
    },
  };
}

function buildBlocksFromSteps(
  steps: ClientRunActivityEntry[],
  seenStepKeys?: Set<string>,
) {
  const blocks: AssistantRenderBlock[] = [];

  for (const step of steps) {
    const stepKey = getActivityEntryRenderKey(step);
    if (seenStepKeys?.has(stepKey)) {
      continue;
    }

    if (step.kind === "tool") {
      blocks.push({
        kind: "tool_step",
        key: `tool:${stepKey}`,
        entry: step,
      });
    } else {
      blocks.push({
        kind: "lifecycle_note",
        key: `lifecycle:${stepKey}`,
        entry: step,
      });
    }
  }

  return blocks;
}

function buildRenderableAssistantBlocks(args: {
  content: string;
  run: ClientRunHistoryItem | null;
  segmentation?: RunContentSegmentation | null;
  streaming?: boolean;
}) {
  const steps = summarizeRenderableSteps(args.run);
  const blocks: AssistantRenderBlock[] = [];
  const content = args.content;
  const renderMode = args.run?.assistantRenderMode ?? "markdown";

  if (args.segmentation && args.segmentation.stepKeys.length > 0) {
    const stepMap = new Map(steps.map((step) => [getActivityEntryRenderKey(step), step]));

    args.segmentation.stepKeys.forEach((stepKey, index) => {
      const segment = args.segmentation?.segments[index] ?? "";
      if (segment.trim()) {
        blocks.push({
          kind: "markdown_text",
          key: `text:${index}:${stepKey}`,
          content: segment,
          renderMode,
        });
      }

      const step = stepMap.get(stepKey);
      if (step?.kind === "tool") {
        blocks.push({
          kind: "tool_step",
          key: `tool:${stepKey}`,
          entry: step,
        });
      } else if (step?.kind === "lifecycle") {
        blocks.push({
          kind: "lifecycle_note",
          key: `lifecycle:${stepKey}`,
          entry: step,
        });
      }
    });

    const trailingText = content.slice(args.segmentation.capturedTextLength);
    if (trailingText.trim()) {
      blocks.push({
        kind: "markdown_text",
        key: "text:trailing",
        content: trailingText,
        renderMode,
      });
    }

    blocks.push(...buildBlocksFromSteps(steps, new Set(args.segmentation.stepKeys)));
  } else if (args.run?.contentCheckpoints.length) {
    const stepMap = new Map(steps.map((step) => [getActivityEntryRenderKey(step), step]));
    const seenKeys = new Set<string>();
    let capturedTextLength = 0;

    for (const checkpoint of args.run.contentCheckpoints) {
      if (checkpoint.text.trim()) {
        blocks.push({
          kind: "markdown_text",
          key: `text:${checkpoint.seq}:${checkpoint.beforeStepKey}`,
          content: checkpoint.text,
          renderMode,
        });
      }

      capturedTextLength += checkpoint.textLength;
      const step = stepMap.get(checkpoint.beforeStepKey);
      if (!step || seenKeys.has(checkpoint.beforeStepKey)) {
        continue;
      }

      seenKeys.add(checkpoint.beforeStepKey);
      if (step.kind === "tool") {
        blocks.push({
          kind: "tool_step",
          key: `tool:${checkpoint.beforeStepKey}`,
          entry: step,
        });
      } else {
        blocks.push({
          kind: "lifecycle_note",
          key: `lifecycle:${checkpoint.beforeStepKey}`,
          entry: step,
        });
      }
    }

    const trailingText = content.slice(capturedTextLength);
    if (trailingText.trim()) {
      blocks.push({
        kind: "markdown_text",
        key: "text:trailing",
        content: trailingText,
        renderMode,
      });
    }

    blocks.push(...buildBlocksFromSteps(steps, seenKeys));
  } else {
    blocks.push(...buildBlocksFromSteps(steps));

    if (content.trim()) {
      blocks.push({
        kind: "markdown_text",
        key: "text:full",
        content,
        renderMode,
      });
    }
  }

  if (blocks.length === 0 && content.trim()) {
    blocks.push({
      kind: "markdown_text",
      key: "text:only",
      content,
      renderMode,
    });
  }

  if (args.streaming && blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    blocks[blocks.length - 1] = {
      ...last,
      streaming: true,
    };
  }

  return blocks;
}

function mergeRunActivityEntries(
  current: ClientRunActivityEntry[],
  incoming: ClientRunActivityEntry,
) {
  if (incoming.kind === "tool" && incoming.tool.callId) {
    const existingIndex = current.findIndex(
      (entry) => entry.kind === "tool" && entry.tool.callId === incoming.tool.callId,
    );

    if (existingIndex !== -1) {
      const next = [...current];
      const existing = next[existingIndex] as Extract<ClientRunActivityEntry, { kind: "tool" }>;
      next[existingIndex] = {
        ...existing,
        ...incoming,
        tool: {
          ...existing.tool,
          ...incoming.tool,
        },
      } as Extract<ClientRunActivityEntry, { kind: "tool" }>;
      return next;
    }
  }

  return [...current, incoming].sort((left, right) => left.seq - right.seq);
}

function upsertRunHistoryItem(
  runs: ClientRunHistoryItem[],
  patch: Partial<ClientRunHistoryItem> & Pick<ClientRunHistoryItem, "runId">,
) {
  const index = runs.findIndex((item) => item.runId === patch.runId);
  if (index === -1) {
    return runs;
  }

  const next = [...runs];
  next[index] = {
    ...next[index],
    ...patch,
    steps: patch.steps ?? next[index].steps,
  };
  return next;
}

function buildRunActivityEntryFromEvent(payload: ClientChatRunEvent): ClientRunActivityEntry | null {
  if (payload.type === "tool") {
    return {
      kind: "tool",
      key: payload.tool.key || `tool:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      tool: payload.tool,
    };
  }

  if (payload.type === "started") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      phase: "started",
      title: "",
      detail: null,
      diagnostic: null,
    };
  }

  if (payload.type === "done") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      phase: "completed",
      title: "",
      detail: null,
      diagnostic: null,
    };
  }

  if (payload.type === "aborted") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      phase: "aborted",
      title: "",
      detail: payload.reason,
      diagnostic: null,
    };
  }

  if (payload.type === "pairing_required") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      phase: "pairing_required",
      title: "",
      detail: payload.pairing.message,
      diagnostic: normalizeDiagnostic(payload.pairing.message, payload.pairing.diagnostic),
    };
  }

  if (payload.type === "error") {
    return {
      kind: "lifecycle",
      key: `lifecycle:${payload.runId}:${payload.seq}`,
      runId: payload.runId,
      seq: payload.seq,
      createdAt: payload.createdAt,
      phase: "failed",
      title: "",
      detail: payload.error,
      diagnostic: normalizeDiagnostic(payload.error, payload.errorDiagnostic),
    };
  }

  return null;
}

function ErrorDiagnosticDetails({
  messages,
  diagnostic,
}: {
  messages: Dictionary;
  diagnostic: string | null;
}) {
  if (!diagnostic) {
    return null;
  }

  return (
    <details className="mt-2 rounded-[0.65rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-2.5 py-2">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-[color:var(--text-primary)]">
        {messages.common.diagnosticLabel}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-[10px] leading-5 text-[color:var(--text-tertiary)]">
        {diagnostic}
      </pre>
    </details>
  );
}

function AssistantTextBlock({
  content,
  messages,
  renderMode,
  streaming = false,
}: {
  content: string;
  messages: Dictionary;
  renderMode: ClientAssistantRenderMode;
  streaming?: boolean;
}) {
  if (!content.trim()) {
    return null;
  }

  return (
    <div className="whitespace-normal">
      <MessageBody content={content} isUser={false} assistantRenderMode={renderMode} messages={messages} streaming={streaming} />
      {streaming ? <StreamingSpinner messages={messages} /> : null}
    </div>
  );
}

function AssistantToolCard({
  entry,
  messages,
  streaming = false,
}: {
  entry: Extract<ClientRunActivityEntry, { kind: "tool" }>;
  messages: Dictionary;
  streaming?: boolean;
}) {
  const hasDetails = Boolean(entry.tool.outputPreview || entry.tool.raw);
  const summary = entry.tool.summary ?? messages.chat.toolInvocation;

  return (
    <details
      className="rounded-[0.75rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2"
    >
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[color:var(--text-primary)]">{entry.tool.name}</span>
          <span className="text-[11px] text-[color:var(--text-tertiary)]">{summary}</span>
          {streaming ? <StreamingSpinner messages={messages} /> : null}
        </div>
      </summary>
      {hasDetails ? (
        <div className="mt-2 space-y-2 border-t border-[color:var(--border-subtle)] pt-2">
          {entry.tool.outputPreview ? (
            <p className="whitespace-pre-wrap text-[11px] leading-5 text-[color:var(--text-secondary)]">
              {entry.tool.outputPreview}
            </p>
          ) : null}
          {entry.tool.raw ? (
            <pre className="overflow-x-auto rounded-[0.65rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-2.5 py-2 text-[10px] leading-5 text-[color:var(--text-tertiary)]">
              {JSON.stringify(entry.tool.raw, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function AssistantLifecycleNote({
  entry,
  messages,
  streaming = false,
}: {
  entry: Extract<ClientRunActivityEntry, { kind: "lifecycle" }>;
  messages: Dictionary;
  streaming?: boolean;
}) {
  return (
    <div className="rounded-[0.75rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-badge rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]">
          {entry.phase.replace("_", " ")}
        </span>
        <span className="text-xs font-medium text-[color:var(--text-primary)]">{getLifecycleTitle(messages, entry.phase)}</span>
        {streaming ? <StreamingSpinner messages={messages} /> : null}
      </div>
      {entry.detail ? (
        <p className="mt-1 text-[11px] leading-5 text-[color:var(--text-tertiary)]">{truncateText(entry.detail, 260)}</p>
      ) : null}
      <ErrorDiagnosticDetails messages={messages} diagnostic={entry.diagnostic} />
    </div>
  );
}

function AttachmentBadge({
  attachment,
  messages,
  tone = "composer",
  onRemove,
}: {
  attachment: Attachment;
  messages: Dictionary;
  tone?: "composer" | "user-message" | "assistant-message";
  onRemove?: (attachmentId: string) => void;
}) {
  const styles =
    tone === "user-message"
        ? {
            outer:
              "border-[rgba(17,24,39,0.14)] bg-[#f3f4f6] text-[color:var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
          meta: "text-[color:var(--text-tertiary)]",
        }
      : tone === "assistant-message"
        ? {
            outer:
              "border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] text-[color:var(--text-primary)]",
            meta: "text-[color:var(--text-tertiary)]",
          }
        : {
            outer:
              "border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)] text-[color:var(--text-primary)]",
            meta: "text-[color:var(--text-tertiary)]",
        };
  const removable = tone === "composer" && Boolean(onRemove);

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-[0.9rem] border px-2.5 py-1.5 text-[10px] leading-tight sm:px-3 sm:text-[11px] ${styles.outer}`}
    >
      <span className="min-w-0 flex flex-1 items-center gap-1.5">
        <span className="min-w-0 shrink truncate font-semibold">{attachment.originalName}</span>
        <span className={`shrink-0 ${styles.meta}`}>
          {attachment.mime || messages.chat.unknown} · {formatFileSize(attachment.size)}
        </span>
      </span>
      {removable ? (
        <button
          type="button"
          onClick={() => onRemove?.(attachment.id)}
          aria-label={`${messages.common.cancel} ${attachment.originalName}`}
          className="inline-flex size-4 shrink-0 items-center justify-center text-[0.8em] leading-none opacity-70 transition-opacity hover:opacity-100"
        >
          <CloseIcon />
        </button>
      ) : null}
    </span>
  );
}

function SkillBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ui-badge rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]">
      {children}
    </span>
  );
}

function SelectedSkillBadge({
  skill,
  messages,
  tone = "composer",
  onRemove,
}: {
  skill: SelectedSkill;
  messages: Dictionary;
  tone?: "composer" | "user-message";
  onRemove?: (skillKey: string) => void;
}) {
  const styles =
    tone === "user-message"
      ? "border-[rgba(14,116,144,0.18)] bg-[#cffafe] text-[#164e63]"
      : "border-[rgba(14,116,144,0.14)] bg-[#ecfeff] text-[#155e75]";

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-[0.9rem] border px-2.5 py-1.5 text-[10px] leading-tight shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] sm:px-3 sm:text-[11px] ${styles}`}
    >
      <span aria-hidden="true" className="shrink-0 opacity-80">
        <WrenchIcon />
      </span>
      <span className="truncate font-semibold">{skill.name}</span>
      {tone === "composer" && onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(skill.key)}
          aria-label={`${messages.common.cancel} ${skill.name}`}
          className="inline-flex size-4 shrink-0 items-center justify-center text-[0.8em] leading-none opacity-70 transition-opacity hover:opacity-100"
        >
          <CloseIcon />
        </button>
      ) : null}
    </span>
  );
}

function SkillListItemCard({
  skill,
  messages,
  selected = false,
  onToggle,
}: {
  skill: Skill;
  messages: Dictionary;
  selected?: boolean;
  onToggle?: (skill: Skill) => void;
}) {
  const selectable = skill.eligible && !skill.disabled && !skill.blockedByAllowlist;

  return (
    <button
      type="button"
      onClick={() => onToggle?.(skill)}
      disabled={!selectable}
      className={`block w-full rounded-[0.8rem] border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-[rgba(14,116,144,0.28)] bg-[#ecfeff]"
          : "border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)]"
      } ${!selectable ? "cursor-not-allowed opacity-70" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-semibold text-[color:var(--text-primary)]">{skill.name}</p>
        {selected ? <SkillBadge>{messages.chat.skillSelected}</SkillBadge> : null}
        <SkillBadge>{getSkillStatus(messages, skill)}</SkillBadge>
        <SkillBadge>{skill.bundled ? "bundled" : skill.source}</SkillBadge>
      </div>
      {skill.description ? (
        <p className="mt-1 overflow-hidden text-[11px] leading-5 text-[color:var(--text-secondary)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {skill.description}
        </p>
      ) : null}
    </button>
  );
}

function CommandBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[rgba(17,24,39,0.08)] bg-[rgba(17,24,39,0.05)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
      {children}
    </span>
  );
}

function highlightSlashLabel(label: string, query: string) {
  const normalizedQuery = normalizeSlashSearchTerm(query);
  if (!normalizedQuery) {
    return label;
  }

  const lowerLabel = label.toLowerCase();
  const matchIndex = lowerLabel.indexOf(normalizedQuery);
  if (matchIndex === -1) {
    return label;
  }

  const matchEnd = matchIndex + normalizedQuery.length;
  return (
    <>
      {label.slice(0, matchIndex)}
      <mark className="bg-[rgba(14,116,144,0.14)] px-0 text-current">
        {label.slice(matchIndex, matchEnd)}
      </mark>
      {label.slice(matchEnd)}
    </>
  );
}

function SlashCommandItemCard({
  item,
  query,
  messages,
  selected = false,
  onSelect,
}: {
  item: SlashSuggestionItem;
  query: string;
  messages: Dictionary;
  selected?: boolean;
  onSelect?: (item: SlashSuggestionItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(item)}
      className={`block w-full rounded-[0.85rem] border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-[rgba(14,116,144,0.28)] bg-[#ecfeff]"
          : "border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-xs font-semibold text-[color:var(--text-primary)]">
          {highlightSlashLabel(item.kind === "openclaw-command" ? item.label : `/${item.label}`, query)}
        </p>
        <CommandBadge>{item.kind === "openclaw-command" ? messages.chat.slashCommandBadge : messages.chat.slashSkillBadge}</CommandBadge>
      </div>
      {item.description ? (
        <p className="mt-1 overflow-hidden text-[11px] leading-5 text-[color:var(--text-secondary)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {item.description}
        </p>
      ) : null}
      {item.kind === "openclaw-command" && item.argumentHint ? (
        <p className="mt-1 text-[10px] leading-4 text-[color:var(--text-tertiary)]">{item.argumentHint}</p>
      ) : null}
    </button>
  );
}

function SlashCommandList({
  suggestions,
  highlightedIndex,
  query,
  messages,
  loadingSkills,
  skillsError,
  onSelect,
}: {
  suggestions: SlashSuggestionItem[];
  highlightedIndex: number;
  query: string;
  messages: Dictionary;
  loadingSkills: boolean;
  skillsError: string | null;
  onSelect: (item: SlashSuggestionItem) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }

    const itemElement = listElement.querySelector<HTMLElement>(`[data-slash-index="${highlightedIndex}"]`);
    itemElement?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, suggestions]);

  if (!suggestions.length && !loadingSkills && !skillsError) {
    return (
      <div className="ui-field-note rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2.5 text-[color:var(--text-secondary)]">
        {query ? messages.chat.slashNoMatches : messages.chat.slashStartTyping}
      </div>
    );
  }

  return (
    <div ref={listRef} className="space-y-2">
      {skillsError ? (
        <p className="ui-field-note text-amber-700">{skillsError}</p>
      ) : null}
      {loadingSkills ? (
        <p className="ui-field-note text-[color:var(--text-secondary)]">{messages.chat.slashLoading}</p>
      ) : null}
      {suggestions.length ? (
        <div className="space-y-2">
          {suggestions.map((item, index) => (
            <div key={`${item.kind}:${item.key}`} data-slash-index={index}>
              <SlashCommandItemCard
                item={item}
                query={query}
                messages={messages}
                selected={index === highlightedIndex}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlashCommandHint({
  command,
  messages,
}: {
  command: SlashCommandDefinition;
  messages: Dictionary;
}) {
  return (
    <div className="mt-1.5 rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-2.5 py-2 text-[11px] text-[color:var(--text-secondary)]">
      <p className="font-medium text-[color:var(--text-primary)]">{command.label}</p>
      <p className="mt-1">{command.description}</p>
      {command.argumentHint ? (
        <p className="mt-1 text-[color:var(--text-tertiary)]">
          {t(messages.chat.slashArgumentHint, { hint: command.argumentHint })}
        </p>
      ) : null}
    </div>
  );
}

function CopyIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="5.25" y="3.25" width="7.5" height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.75 10.75h-.5A1.5 1.5 0 0 1 1.75 9.25v-6A1.5 1.5 0 0 1 3.25 1.75h4A1.5 1.5 0 0 1 8.75 3.25v.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="m3.5 8.25 2.6 2.6 6.4-6.35"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const COPY_ICON_CLASS_NAME = "size-4.5";
const COPY_ICON_BUTTON_CLASS_NAME = "ui-icon-button justify-center hover:bg-[rgba(107,114,128,0.16)]";

async function copyText(text: string) {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function" &&
    typeof window !== "undefined" &&
    window.isSecureContext
  ) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (selection) {
    selection.removeAllRanges();
    if (originalRange) {
      selection.addRange(originalRange);
    }
  }

  if (!copied) {
    throw new Error("Copy command failed");
  }
}

function CopyButton({
  text,
  successLabel,
  ariaLabel,
  className = "",
  iconClassName,
  iconButtonClassName = "",
}: {
  text: string;
  successLabel: string;
  ariaLabel: string;
  className?: string;
  iconClassName?: string;
  iconButtonClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!text) {
      return;
    }

    try {
      await copyText(text);
      setCopied(true);

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 1800);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? successLabel : ariaLabel}
      disabled={!text}
      className={`inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[11px] font-medium transition-colors ${
        copied
          ? "text-[#155e75]"
          : "text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
      } ${iconButtonClassName} ${!text ? "cursor-default opacity-60" : ""} ${className}`}
    >
      {copied ? (
        <span aria-hidden="true" className="shrink-0">
          <CheckIcon className={iconClassName} />
        </span>
      ) : (
        <span aria-hidden="true" className="shrink-0">
          <CopyIcon className={iconClassName} />
        </span>
      )}
    </button>
  );
}

function MessageCopyButton({
  content,
  messages,
  className = "",
}: {
  content: string;
  messages: Dictionary;
  className?: string;
}) {
  if (!content.trim()) {
    return null;
  }

  return (
    <CopyButton
      text={content}
      successLabel={messages.chat.copied}
      ariaLabel={messages.chat.copyMessage}
      className={className}
      iconClassName={COPY_ICON_CLASS_NAME}
      iconButtonClassName={COPY_ICON_BUTTON_CLASS_NAME}
    />
  );
}

function MessageBody({
  content,
  isUser,
  assistantRenderMode = "markdown",
  messages,
  streaming = false,
}: {
  content: string;
  isUser: boolean;
  assistantRenderMode?: ClientAssistantRenderMode;
  messages: Dictionary;
  streaming?: boolean;
}) {
  if (!content.trim()) {
    return null;
  }

  if (isUser) {
    return <p className="whitespace-pre-wrap text-sm leading-7">{content}</p>;
  }

  if (assistantRenderMode === "plain_text") {
    return (
      <pre className="whitespace-pre-wrap break-words rounded-[0.65rem] bg-[color:var(--surface-subtle)] px-3 py-2 text-sm leading-7 text-[color:var(--text-primary)]">
        {content}
      </pre>
    );
  }

  return (
    <div className="markdown-body min-w-0 max-w-full text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => (
            <CodeBlock {...props} messages={messages} streaming={streaming}>
              {children}
            </CodeBlock>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function StreamingSpinner({ messages }: { messages: Dictionary }) {
  return (
    <span
      aria-label={messages.chat.streaming}
      className="ml-2 inline-block size-3 animate-spin rounded-full border-2 border-[rgba(17,24,39,0.18)] border-t-[color:var(--text-primary)] align-middle"
    />
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      {collapsed ? (
        <>
          <path
            d="M6.5 5.5 10.5 10l-4 4.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
          />
          <path
            d="M10.5 5.5 14.5 10l-4 4.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
          />
        </>
      ) : (
        <>
          <path
            d="M13.5 5.5 9.5 10l4 4.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
          />
          <path
            d="M9.5 5.5 5.5 10l4 4.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.75"
          />
        </>
      )}
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      <path
        d="M6.25 15.625 3.75 17.5v-3.125A5.625 5.625 0 0 1 2.5 10.625C2.5 7.519 5.578 5 9.375 5h1.25c3.797 0 6.875 2.52 6.875 5.625s-3.078 5.625-6.875 5.625H6.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path
        d="M7.5 10.625h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      <path
        d="M5 5 15 15M15 5 5 15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 1024 1024" fill="currentColor" className="size-3.5">
      <path d="M388.562 512.631c0 8.814 7.154 15.949 15.948 15.949h329.713c8.813 0 15.947-7.135 15.947-15.949 0-8.794-7.134-15.948-15.947-15.948H404.51c-8.795 0-15.948 7.154-15.948 15.948z m345.661 139.62H404.51c-8.794 0-15.948 7.153-15.948 15.948 0 8.813 7.154 15.947 15.948 15.947h329.713c8.813 0 15.947-7.134 15.947-15.947 0-8.795-7.134-15.948-15.947-15.948z m0 156.122H404.51c-8.794 0-15.948 7.153-15.948 15.947 0 8.813 7.154 15.947 15.948 15.947h329.713c8.813 0 15.947-7.134 15.947-15.947 0-8.794-7.134-15.947-15.947-15.947zM404.194 360.482h121.22c8.874 0 16.067-7.193 16.067-16.066 0-8.874-7.193-16.067-16.067-16.067h-121.22c-8.874 0-16.067 7.193-16.067 16.067 0 8.873 7.193 16.066 16.067 16.066z m-0.119-156.003h146.991c8.339 0 15.078-6.739 15.078-15.079 0-8.32-6.739-15.059-15.078-15.059H404.075c-8.32 0-15.059 6.739-15.059 15.059 0 8.34 6.739 15.079 15.059 15.079z" />
      <path d="M145.901 969.078c-5.059 0.652 5.198 0 0 0zM845.8 56.184H389.353c-67.231 0-121.715 54.504-121.715 121.716v486.88h-91.302c-84.029 0-152.149 68.121-152.149 152.149 0 78.831 44.919 144.422 121.715 152.148h608.597c67.231 0 121.735-54.483 121.735-121.715V357.419c69.444-14.091 121.716-75.472 121.716-149.086-0.001-84.029-68.121-152.149-152.15-152.149zM179.28 935.759h-2.945c-66.994 0-118.632-31.382-118.632-118.829 0-62.646 41.52-116.419 118.632-116.419h91.302v116.715c0.217 58.476-28.438 118.533-88.357 118.533z m664.484-88.396c0 49.82-32.884 86.499-89.266 86.499H253.112c34.149-16.837 48.062-82.329 48.062-116.637V177.899c0-51.402 35.829-91.44 88.179-91.44h121.023c19.269 25.493 31.126 87.467 31.126 121.873 0 34.031-11.562 82.112-30.435 107.467v44.683h332.696v486.881z m2.036-517.315H538.952c23.616-38.694 32.983-89.048 32.983-121.715 0-51.461-15.612-94.187-28.774-121.873H845.8c50.334 0 123.178 36.046 123.178 121.873 0 85.55-72.844 121.715-123.178 121.715z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      <path
        d="M7.5 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5 5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0-10a2.5 2.5 0 1 0 0 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <path d="m9.55 8.85 2.9 1.8m-2.9 0 2.9-1.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function StopSquareIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      <rect
        x="5.25"
        y="5.25"
        width="9.5"
        height="9.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="7"
        y="7"
        width="6"
        height="6"
        rx="1"
        fill="currentColor"
      />
    </svg>
  );
}

function formatCompactTokenCount(value: number) {
  const normalized = Math.max(0, value);
  if (normalized >= 1000) {
    const compact = normalized / 1000;
    const fractionDigits = compact >= 100 ? 0 : compact >= 10 ? 1 : 1;
    return `${compact.toFixed(fractionDigits).replace(/\.0$/, "")}k`;
  }

  return new Intl.NumberFormat("en-US").format(Math.round(normalized));
}

function formatUsagePercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function ComposerContextUsagePanel({
  messages,
  loading,
  usagePercent,
  usageRatio,
  used,
  total,
  remaining,
}: {
  messages: Dictionary;
  loading: boolean;
  usagePercent: string;
  usageRatio: number;
  used: number;
  total: number;
  remaining: number;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">
          {messages.chat.contextSummaryLabel}
        </p>
        <span className="text-[11px] font-semibold text-[color:var(--text-secondary)]">
          {loading ? "..." : usagePercent}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[rgba(15,23,42,0.08)]">
        <div
          className={`h-full rounded-full transition-[width,background-color] duration-300 ${
            usageRatio >= 1
              ? "bg-red-500"
              : usageRatio >= 0.85
                ? "bg-amber-500"
                : "bg-[color:var(--text-primary)]"
          } ${loading ? "animate-pulse opacity-50" : ""}`}
          style={{ width: `${Math.max(4, Math.round((loading ? 0.12 : usageRatio) * 100))}%` }}
        />
      </div>
      <div className="mt-2.5 space-y-1.5 text-[11px] text-[color:var(--text-secondary)]">
        <div className="flex items-center justify-between gap-3">
          <span>{messages.chat.contextUsedLabel}</span>
          <span className="font-medium text-[color:var(--text-primary)]">
            {loading ? "..." : formatCompactTokenCount(used)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>{messages.chat.contextTotalLabel}</span>
          <span className="font-medium text-[color:var(--text-primary)]">
            {loading ? "..." : formatCompactTokenCount(total)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>{messages.chat.contextRemainingLabel}</span>
          <span className="font-medium text-[color:var(--text-primary)]">
            {loading ? "..." : formatCompactTokenCount(remaining)}
          </span>
        </div>
      </div>
    </>
  );
}

function ComposerContextUsage({
  usage,
  loading,
  messages,
}: {
  usage: SessionContextUsage | null;
  loading: boolean;
  messages: Dictionary;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const desktopPanelRef = useRef<HTMLDivElement | null>(null);
  const mobilePanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const isInsideContainer = containerRef.current?.contains(target) ?? false;
      const isInsideDesktopPanel = desktopPanelRef.current?.contains(target) ?? false;
      const isInsideMobilePanel = mobilePanelRef.current?.contains(target) ?? false;

      if (!isInsideContainer && !isInsideDesktopPanel && !isInsideMobilePanel) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!usage && !loading) {
    return null;
  }

  const usageRatio = usage?.usageRatio ?? 0;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - usageRatio);
  const progressClassName =
    usage && usageRatio >= 1
      ? "stroke-red-500"
      : usage && usageRatio >= 0.85
        ? "stroke-amber-500"
        : "stroke-[color:var(--text-primary)]";
  const used = usage?.usedTokens ?? 0;
  const total = usage?.totalTokens ?? 0;
  const remaining = usage?.remainingTokens ?? 0;
  const usagePercent = formatUsagePercent(usageRatio);
  const isLoadingState = loading && !usage;
  const title = isLoadingState
    ? messages.chat.contextLoading
    : `${messages.chat.contextSummaryLabel} ${usagePercent}`;
  const handleHoverOpen = () => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      setOpen(true);
    }
  };
  const handleHoverClose = () => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      setOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative inline-flex shrink-0 items-center justify-center"
      onMouseEnter={handleHoverOpen}
      onMouseLeave={handleHoverClose}
    >
      <button
        type="button"
        className="ui-icon-button inline-flex shrink-0 text-[color:var(--text-secondary)] outline-none transition hover:text-[color:var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[color:var(--border-strong)]"
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`size-6 -rotate-90 sm:size-6 ${isLoadingState ? "animate-pulse opacity-60" : ""}`}
        >
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="rgba(15,23,42,0.14)"
            strokeWidth="2.5"
          />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={`transition-[stroke-dashoffset,stroke] duration-300 ${progressClassName}`}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>
      </button>
      {open ? (
        <>
          <div
            ref={desktopPanelRef}
            className="absolute bottom-full left-0 z-30 mb-2 hidden w-56 max-w-[calc(100vw-2rem)] rounded-[0.85rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] p-3 text-left shadow-[var(--shadow-panel)] backdrop-blur sm:block"
          >
            <span
              aria-hidden="true"
              className="absolute bottom-[-0.35rem] left-3 size-3 rotate-45 border-r border-b border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)]"
            />
            <ComposerContextUsagePanel
              messages={messages}
              loading={isLoadingState}
              usagePercent={usagePercent}
              usageRatio={usageRatio}
              used={used}
              total={total}
              remaining={remaining}
            />
          </div>
          <button
            type="button"
            aria-label={messages.common.cancel}
            onClick={() => setOpen(false)}
            className="ui-overlay fixed inset-0 z-20 sm:hidden"
          />
          <div
            ref={mobilePanelRef}
            role="dialog"
            aria-modal="true"
            aria-label={messages.chat.contextSummaryLabel}
            className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] z-30 sm:hidden"
          >
            <div className="rounded-[1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-3 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-[color:var(--text-primary)]">{messages.chat.contextSummaryLabel}</p>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="ui-button-secondary ui-button-chip font-medium"
                >
                  {messages.common.cancel}
                </button>
              </div>
              <ComposerContextUsagePanel
                messages={messages}
                loading={isLoadingState}
                usagePercent={usagePercent}
                usageRatio={usageRatio}
                used={used}
                total={total}
                remaining={remaining}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const ChatMessageItem = memo(function ChatMessageItem({
  item,
  segmentation,
  locale,
  messages,
}: {
  item: RenderableMessage;
  segmentation: RunContentSegmentation | null;
  locale: Locale;
  messages: Dictionary;
}) {
  const isUser = item.kind === "message" && item.message.role === "USER";
  const run = item.run;
  const content = item.kind === "message" ? item.message.content : item.run.draftAssistantContent;
  const createdAt = item.kind === "message" ? item.message.createdAt : item.run.updatedAt;
  const skills = item.kind === "message" ? item.message.skills : [];
  const attachments = item.kind === "message" ? item.message.attachments : [];
  const assistantBlocks = useMemo(
    () =>
      !isUser
        ? buildRenderableAssistantBlocks({
            content,
            run,
            segmentation,
          })
        : [],
    [content, isUser, run, segmentation],
  );

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`min-w-0 rounded-[0.8rem] border px-2 py-1.75 sm:px-3 sm:py-2 ${
          isUser
            ? "ml-auto w-fit max-w-[min(100%,44rem)] border-[rgba(17,24,39,0.18)] bg-[#d1d5db] text-[color:var(--text-primary)] shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
            : "mr-auto self-start max-w-[min(124ch,calc(100%-2.5rem))] border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)] text-[color:var(--text-primary)]"
        }`}
      >
        <div>
          {isUser ? (
            <MessageBody content={content} isUser messages={messages} />
          ) : (
            <div className="space-y-3">
              {assistantBlocks.map((block) => {
                if (block.kind === "markdown_text") {
                  return <AssistantTextBlock key={block.key} content={block.content} renderMode={block.renderMode} messages={messages} streaming={block.streaming ? true : false} />;
                }

                if (block.kind === "tool_step") {
                  return <AssistantToolCard key={block.key} entry={block.entry} messages={messages} streaming={block.streaming} />;
                }

                return <AssistantLifecycleNote key={block.key} entry={block.entry} messages={messages} streaming={block.streaming} />;
              })}
            </div>
          )}
          {skills.length || attachments.length ? (
            <div
              className={`mt-2 flex flex-wrap gap-1.5 border-t pt-2 ${
                isUser ? "border-[rgba(17,24,39,0.12)]" : "border-[color:var(--border-subtle)]"
              }`}
            >
              {skills.map((skill) => (
                <SelectedSkillBadge
                  key={skill.key}
                  skill={skill}
                  messages={messages}
                  tone={isUser ? "user-message" : "composer"}
                />
              ))}
              {attachments.map((attachment) => (
                <AttachmentBadge
                  key={attachment.id}
                  attachment={attachment}
                  messages={messages}
                  tone={isUser ? "user-message" : "assistant-message"}
                />
              ))}
            </div>
          ) : null}
        </div>
        <p className={`mt-1 text-[10px] ${isUser ? "text-[color:var(--text-tertiary)]" : "text-[color:var(--text-quaternary)]"}`}>
          {formatRelativeDate(createdAt, locale, messages.common.noActivityYet)}
        </p>
      </div>
      <div className={`mt-1 flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
        <MessageCopyButton content={content} messages={messages} />
      </div>
    </div>
  );
});

const ActiveRunPanel = memo(function ActiveRunPanel({
  activeRun,
  activeRunBlocks,
  locale,
  messages,
}: {
  activeRun: SessionRun;
  activeRunBlocks: AssistantRenderBlock[];
  locale: Locale;
  messages: Dictionary;
}) {
  return (
    <div className="flex flex-col items-start">
      <div className="mr-auto min-w-0 self-start max-w-[min(124ch,calc(100%-2.5rem))] rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)] px-2 py-1.75 text-[color:var(--text-primary)] sm:px-3 sm:py-2">
        <div>
          <div className="space-y-3">
            {activeRunBlocks.map((block) => {
              if (block.kind === "markdown_text") {
                return <AssistantTextBlock key={block.key} content={block.content} renderMode={block.renderMode} messages={messages} streaming={block.streaming} />;
              }

              if (block.kind === "tool_step") {
                return <AssistantToolCard key={block.key} entry={block.entry} messages={messages} streaming={block.streaming} />;
              }

              return <AssistantLifecycleNote key={block.key} entry={block.entry} messages={messages} streaming={block.streaming} />;
            })}
            {activeRunBlocks.length === 0 ? (
              <div className="flex items-center text-sm text-[color:var(--text-tertiary)]">
                <StreamingSpinner messages={messages} />
              </div>
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-[10px] text-[color:var(--text-quaternary)]">
          {formatRelativeDate(activeRun.updatedAt, locale, messages.common.noActivityYet)}
        </p>
      </div>
      <div className="mt-1 flex w-full justify-start">
        <MessageCopyButton content={activeRun.draftAssistantContent} messages={messages} />
      </div>
    </div>
  );
});

const ChatSidebar = memo(function ChatSidebar({
  locale,
  messages,
  drawerOpen,
  isSidebarCollapsed,
  user,
  recentSessions,
  archivedSessions,
  loadingMore,
  loadMoreError,
  sessionsScrollerRef,
  loadMoreSentinelRef,
  onCloseDrawer,
  onCollapseSidebar,
  onExpandSidebar,
  onCreateSession,
  onSelectSession,
  onOpenRenameModal,
  onLoadMoreSessions,
}: {
  locale: Locale;
  messages: Dictionary;
  drawerOpen: boolean;
  isSidebarCollapsed: boolean;
  user: UserShape;
  recentSessions: Array<{ session: Session; isActive: boolean; isBusy: boolean }>;
  archivedSessions: Array<{ session: Session; isActive: boolean; isBusy: boolean }>;
  loadingMore: boolean;
  loadMoreError: string | null;
  sessionsScrollerRef: RefObject<HTMLDivElement | null>;
  loadMoreSentinelRef: RefObject<HTMLDivElement | null>;
  onCloseDrawer: () => void;
  onCollapseSidebar: () => void;
  onExpandSidebar: () => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenRenameModal: (session: Session) => void;
  onLoadMoreSessions: () => void;
}) {
  const GROUP_PAGE_SIZE = 20;
  const collapsedSessions = [...recentSessions, ...archivedSessions];
  const [recentExpanded, setRecentExpanded] = useState(true);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [recentVisibleCount, setRecentVisibleCount] = useState(GROUP_PAGE_SIZE);
  const [archivedVisibleCount, setArchivedVisibleCount] = useState(GROUP_PAGE_SIZE);
  const activeRecentIndex = recentSessions.findIndex(({ isActive }) => isActive);
  const activeArchivedIndex = archivedSessions.findIndex(({ isActive }) => isActive);
  const effectiveRecentVisibleCount = Math.max(
    recentVisibleCount,
    activeRecentIndex >= 0 ? activeRecentIndex + 1 : 0,
    GROUP_PAGE_SIZE,
  );
  const effectiveArchivedVisibleCount = Math.max(
    archivedVisibleCount,
    activeArchivedIndex >= 0 ? activeArchivedIndex + 1 : 0,
    GROUP_PAGE_SIZE,
  );
  const visibleRecentSessions = recentSessions.slice(0, effectiveRecentVisibleCount);
  const visibleArchivedSessions = archivedSessions.slice(0, effectiveArchivedVisibleCount);
  const recentHasMore = recentSessions.length > effectiveRecentVisibleCount;
  const archivedHasMore = archivedSessions.length > effectiveArchivedVisibleCount;

  useEffect(() => {
    if (activeRecentIndex < 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setRecentExpanded(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeRecentIndex]);

  useEffect(() => {
    if (activeArchivedIndex < 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      setArchivedExpanded(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeArchivedIndex]);

  const renderSessionButton = (
    { session, isActive, isBusy }: { session: Session; isActive: boolean; isBusy: boolean },
    options?: { collapsed?: boolean },
  ) => {
    const collapsed = options?.collapsed ?? false;

    return (
      <button
        key={session.id}
        type="button"
        onClick={() => onSelectSession(session.id)}
        onDoubleClick={() => {
          if (session.status === "ACTIVE") {
            onOpenRenameModal(session);
          }
        }}
        title={collapsed ? session.title : undefined}
      className={`w-full rounded-[0.9rem] border text-left transition ${
          collapsed ? "px-2 py-2.5 lg:min-h-10" : "min-h-[var(--touch-target-min)] px-3 py-2.5"
        } ${
          isActive
            ? "border-[color:var(--border-strong)] bg-[color:var(--surface-muted)]"
            : "border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.68)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-panel-strong)]"
        } ${session.status === "ARCHIVED" ? "opacity-80" : ""}`}
      >
        {collapsed ? (
          <div className="flex items-center justify-center">
            <span className="ui-badge-strong flex size-7 items-center justify-center rounded-full text-[11px] font-semibold uppercase">
              {session.title.slice(0, 1)}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{session.title}</p>
            {isBusy ? (
              <span className="ui-badge shrink-0 rounded-full px-2 py-0.5 text-[10px]">
                {messages.chat.live}
              </span>
            ) : session.status === "ARCHIVED" ? (
              <span className="ui-badge shrink-0 rounded-full px-2 py-0.5 text-[10px]">
                {messages.chat.readOnly}
              </span>
            ) : null}
          </div>
        )}
      </button>
    );
  };

  const renderSectionHeader = ({
    title,
    count,
    expanded,
    onToggle,
  }: {
    title: string;
    count: number;
    expanded: boolean;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      onClick={onToggle}
      className="flex min-h-[2.25rem] w-full items-center justify-between rounded-[0.75rem] px-2 py-1.5 text-left transition hover:bg-[color:var(--surface-subtle)]"
      aria-expanded={expanded}
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--text-quaternary)]">
        {title}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-[color:var(--text-quaternary)]">
        <span>{count}</span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </span>
    </button>
  );

  const renderSectionFooter = ({
    expanded,
    totalCount,
    hasMore,
    onShowMore,
  }: {
    expanded: boolean;
    totalCount: number;
    hasMore: boolean;
    onShowMore: () => void;
  }) => {
    if (!expanded || totalCount === 0) {
      return null;
    }

    return (
      <div className="px-1 pt-1 text-center">
        {hasMore ? (
          <button
            type="button"
            onClick={onShowMore}
            className="w-full text-[color:var(--text-secondary)] transition hover:text-[color:var(--text-primary)]"
          >
            <span className="text-[9px]">{messages.chat.showMore}</span>
          </button>
        ) : totalCount > GROUP_PAGE_SIZE ? (
          <div className="w-full text-[color:var(--text-quaternary)]">
            <span className="text-[9px]">{messages.chat.noMoreSessions}</span>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside
          className={`fixed inset-y-1.5 left-1.5 z-30 flex w-[calc(100vw-0.75rem)] max-w-[20rem] shrink-0 flex-col overflow-hidden rounded-[1.1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.96)] shadow-[var(--shadow-panel)] transition-[width,transform] duration-300 lg:static lg:inset-auto lg:z-auto lg:h-full lg:max-w-none lg:rounded-[0.9rem] ${
        drawerOpen ? "translate-x-0" : "-translate-x-[108%] lg:translate-x-0"
      } ${isSidebarCollapsed ? "lg:w-[4.25rem]" : "lg:w-[14.5rem] xl:w-[15.25rem]"}`}
    >
      <div className="border-b border-[color:var(--border-subtle)] px-3 py-2.5 sm:px-2.5 sm:py-1.5">
        {isSidebarCollapsed ? (
          <div className="hidden justify-center lg:flex">
            <button
              type="button"
              onClick={onExpandSidebar}
              className="ui-button-secondary ui-icon-button shrink-0"
              aria-label={messages.nav.expandSidebar}
              title={messages.nav.expandSidebar}
            >
              <SidebarToggleIcon collapsed />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[color:var(--text-primary)]">{user.openclawAgentId}</p>
                <p className="mt-0.5 truncate text-[11px] text-[color:var(--text-quaternary)]">{user.username}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCollapseSidebar}
                  className="ui-button-secondary ui-icon-button !hidden shrink-0 lg:!inline-flex"
                  aria-label={messages.nav.collapseSidebar}
                  title={messages.nav.collapseSidebar}
                >
                  <SidebarToggleIcon collapsed={false} />
                </button>
                <button
                  type="button"
                  onClick={onCloseDrawer}
                  className="ui-button-secondary ui-icon-button !inline-flex lg:!hidden"
                  aria-label={messages.nav.closeDrawer}
                  title={messages.nav.closeDrawer}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={onCreateSession}
                className="ui-button-primary min-w-0 flex-1 font-semibold"
              >
                {messages.nav.new}
              </button>
            </div>
          </>
        )}
      </div>

      <div
        ref={sessionsScrollerRef}
        className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5 ${isSidebarCollapsed ? "px-1" : "px-1.5"}`}
      >
        <div className="space-y-1">
          {isSidebarCollapsed ? (
            collapsedSessions.map((item) => renderSessionButton(item, { collapsed: true }))
          ) : (
            <>
              <div className="pt-1">
                {renderSectionHeader({
                  title: messages.chat.recentSessions,
                  count: recentSessions.length,
                  expanded: recentExpanded,
                  onToggle: () => setRecentExpanded((current) => !current),
                })}
              </div>
              {recentExpanded ? visibleRecentSessions.map((item) => renderSessionButton(item)) : null}
              {renderSectionFooter({
                expanded: recentExpanded,
                totalCount: recentSessions.length,
                hasMore: recentHasMore,
                onShowMore: () => setRecentVisibleCount((current) => current + GROUP_PAGE_SIZE),
              })}
              <div className="pt-2">
                {renderSectionHeader({
                  title: messages.chat.archivedSessions,
                  count: archivedSessions.length,
                  expanded: archivedExpanded,
                  onToggle: () => setArchivedExpanded((current) => !current),
                })}
              </div>
              {archivedExpanded ? visibleArchivedSessions.map((item) => renderSessionButton(item)) : null}
              {renderSectionFooter({
                expanded: archivedExpanded,
                totalCount: archivedSessions.length,
                hasMore: archivedHasMore,
                onShowMore: () => setArchivedVisibleCount((current) => current + GROUP_PAGE_SIZE),
              })}
            </>
          )}
          <div ref={loadMoreSentinelRef} className="h-2 w-full" />
          {isSidebarCollapsed ? null : (
            <div className="px-1 py-1.5 text-center text-[11px] text-[color:var(--text-quaternary)]">
              {loadingMore ? (
                <span>{messages.chat.loadingMore}</span>
              ) : loadMoreError ? (
                <button
                  type="button"
                  onClick={onLoadMoreSessions}
                  className="text-[color:var(--text-secondary)] transition hover:text-[color:var(--text-primary)]"
                >
                  {messages.chat.retryLoading}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {isSidebarCollapsed ? null : (
        <div className="border-t border-[color:var(--border-subtle)] px-3 py-2.5 sm:px-2.5 sm:py-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {user.role === "ADMIN" ? (
              <Link
                href={localizeHref(locale, "/admin")}
                className="ui-button-secondary ui-button-chip inline-flex font-medium"
              >
                {messages.nav.admin}
              </Link>
            ) : (
              <span className="hidden" aria-hidden="true" />
            )}
            <LogoutButton
              locale={locale}
              messages={messages}
              className={`ui-button-secondary ui-button-chip inline-flex font-medium ${
                user.role === "ADMIN" ? "" : "col-span-2"
              }`}
            />
          </div>
        </div>
      )}
    </aside>
  );
});

export function ChatShell({
  locale,
  messages,
  initialSessions,
  initialHasMore,
  initialNextCursor,
  initialActiveSessionId,
  initialMessages,
  initialRunHistory,
  initialActiveRun,
  lazycatFilePickerEnabled,
  user,
}: {
  locale: Locale;
  messages: Dictionary;
  initialSessions: Session[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  initialActiveSessionId: string | null;
  initialMessages: Message[];
  initialRunHistory: ClientRunHistoryItem[];
  initialActiveRun: SessionRun | null;
  lazycatFilePickerEnabled: boolean;
  user: UserShape;
}) {
  const pageSize = 20;
  const pathname = usePathname();
  const localeFetch = useCallback(
    (input: string, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          [LOCALE_HEADER_NAME]: locale,
        },
      }),
    [locale],
  );
  const [sessions, setSessions] = useState(initialSessions);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, Message[]>>(
    initialActiveSessionId ? { [initialActiveSessionId]: initialMessages } : {},
  );
  const [runHistoryBySession, setRunHistoryBySession] = useState<Record<string, ClientRunHistoryItem[]>>(
    initialActiveSessionId ? { [initialActiveSessionId]: initialRunHistory } : {},
  );
  const [contentSegmentsByRunId, setContentSegmentsByRunId] = useState<Record<string, RunContentSegmentation>>({});
  const [composerBySession, setComposerBySession] = useState<Record<string, string>>({});
  const [bootstrapComposerText, setBootstrapComposerText] = useState("");
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [pendingAttachmentsBySession, setPendingAttachmentsBySession] = useState<Record<string, Attachment[]>>({});
  const [selectedSkillsBySession, setSelectedSkillsBySession] = useState<Record<string, SelectedSkill[]>>({});
  const [runStateBySession, setRunStateBySession] = useState<Record<string, RunState>>(
    initialActiveSessionId && initialActiveRun
      ? { [initialActiveSessionId]: mapRunStatusToState(initialActiveRun.status) }
      : {},
  );
  const [activeRunBySession, setActiveRunBySession] = useState<Record<string, SessionRun | null>>(
    initialActiveSessionId && initialActiveRun ? { [initialActiveSessionId]: initialActiveRun } : {},
  );
  const [uploadingBySession, setUploadingBySession] = useState<Record<string, boolean>>({});
  const [errorBySession, setErrorBySession] = useState<Record<string, SessionErrorState | null>>({});
  const [deviceAuthorizationExpiredBySession, setDeviceAuthorizationExpiredBySession] = useState<Record<string, boolean>>({});
  const [pairingBySession, setPairingBySession] = useState<Record<string, PairingState | null>>({});
  const [contextUsageBySession, setContextUsageBySession] = useState<Record<string, SessionContextUsageState>>({});
  const [contextLoadingBySession, setContextLoadingBySession] = useState<Record<string, boolean>>({});
  const [loadedSessionIds, setLoadedSessionIds] = useState<Record<string, boolean>>(
    initialActiveSessionId ? { [initialActiveSessionId]: true } : {},
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const [shareState, setShareState] = useState<SessionShare | null>(null);
  const [shareAccessMode, setShareAccessMode] = useState<"PUBLIC" | "PASSWORD">("PUBLIC");
  const [sharePassword, setSharePassword] = useState("");
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareSubmitting, setShareSubmitting] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsFetched, setSkillsFetched] = useState(false);
  const [composerSelection, setComposerSelection] = useState<ComposerSelection>({ start: 0, end: 0 });
  const [dismissedSlashPanelKey, setDismissedSlashPanelKey] = useState<string | null>(null);
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [isPhoneViewport, setIsPhoneViewport] = useState(false);
  const [mobileViewportHeight, setMobileViewportHeight] = useState<number | null>(null);
  const [dockedComposerHeight, setDockedComposerHeight] = useState(0);
  const [lazycatFilePickerAvailable, setLazycatFilePickerAvailable] = useState(false);
  const [lazycatPickerOpen, setLazycatPickerOpen] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionsScrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollerRef = useRef<HTMLDivElement | null>(null);
  const messagesBottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const dockedComposerRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const sharePasswordInputRef = useRef<HTMLInputElement | null>(null);
  const shouldSnapMessagesToBottomRef = useRef(true);
  const shouldStickMessagesToBottomRef = useRef(false);
  const isProgrammaticMessagesScrollRef = useRef(false);
  const isAutoScrollingToBottomRef = useRef(false);
  const showScrollToBottomRef = useRef(false);
  const isBottomSentinelVisibleRef = useRef(true);
  const eventSourcesRef = useRef<Record<string, EventSource>>({});
  const reconnectTimersRef = useRef<Record<string, number>>({});
  const reconnectAttemptsRef = useRef<Record<string, number>>({});
  const activeSessionIdRef = useRef<string | null>(initialActiveSessionId);
  const flushTimersBySessionRef = useRef<Record<string, number>>({});
  const bufferedRunPatchBySessionRef = useRef<Record<string, BufferedRunPatch>>({});
  const lastEventSeqByRunRef = useRef<Record<string, number>>(
    initialActiveRun ? { [initialActiveRun.id]: initialActiveRun.lastEventSeq } : {},
  );
  const contextRequestVersionBySessionRef = useRef<Record<string, number>>({});
  const contextInFlightBySessionRef = useRef<Record<string, boolean>>({});
  const activeRunBySessionRef = useRef<Record<string, SessionRun | null>>(
    initialActiveSessionId && initialActiveRun ? { [initialActiveSessionId]: initialActiveRun } : {},
  );
  const bootstrapComposerTextRef = useRef("");
  const bootstrapPromiseRef = useRef<Promise<string | null> | null>(null);
  const pendingComposerSelectionRef = useRef<ComposerSelection | null>(null);
  const loadSessionRef = useRef<(sessionId: string, clearError?: boolean) => Promise<void>>(async () => {});
  const skillsPopoverRef = useRef<HTMLDivElement | null>(null);
  const mobileSkillsSheetRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const renameTargetSession = useMemo(
    () => sessions.find((session) => session.id === renameSessionId) ?? null,
    [renameSessionId, sessions],
  );
  const shareTargetSession = useMemo(
    () => sessions.find((session) => session.id === shareSessionId) ?? null,
    [shareSessionId, sessions],
  );
  const sessionMessages = useMemo(
    () => (activeSessionId ? messagesBySession[activeSessionId] ?? [] : []),
    [activeSessionId, messagesBySession],
  );
  const runHistory = useMemo(
    () => (activeSessionId ? runHistoryBySession[activeSessionId] ?? [] : []),
    [activeSessionId, runHistoryBySession],
  );
  const text = activeSessionId ? composerBySession[activeSessionId] ?? "" : bootstrapComposerText;
  const pendingAttachments = activeSessionId ? pendingAttachmentsBySession[activeSessionId] ?? [] : [];
  const selectedSkills = activeSessionId ? selectedSkillsBySession[activeSessionId] ?? [] : [];
  const activeRun = activeSessionId ? activeRunBySession[activeSessionId] ?? null : null;
  const loading = activeSessionId ? isRunBusy(runStateBySession[activeSessionId] ?? "idle") : false;
  const uploading = activeSessionId ? uploadingBySession[activeSessionId] ?? false : false;
  const error = activeSessionId ? errorBySession[activeSessionId] ?? null : null;
  const deviceAuthorizationExpired = activeSessionId
    ? deviceAuthorizationExpiredBySession[activeSessionId] ?? false
    : false;
  const pairing = activeSessionId ? pairingBySession[activeSessionId] ?? null : null;
  const contextUsage = activeSessionId ? contextUsageBySession[activeSessionId]?.usage ?? null : null;
  const contextLoading = activeSessionId ? contextLoadingBySession[activeSessionId] ?? false : false;
  const activeSessionReadOnly = activeSession?.status === "ARCHIVED";
  const activeRunHistory = useMemo(
    () => (activeRun ? runHistory.find((item) => item.runId === activeRun.id) ?? null : null),
    [activeRun, runHistory],
  );
  const activeRunSegmentation = activeRun ? contentSegmentsByRunId[activeRun.id] ?? null : null;
  const activeStreamingRunId = activeRun && isActiveSessionRunStatus(activeRun.status) ? activeRun.id : null;
  const shareCopyUrl = useMemo(() => {
    if (!shareState?.shareUrl) {
      return "";
    }

    if (shareState.shareUrl.startsWith("/") && typeof window !== "undefined") {
      return new URL(shareState.shareUrl, window.location.origin).toString();
    }

    return shareState.shareUrl;
  }, [shareState?.shareUrl]);
  const workspaceSettingsHref = localizeHref(locale, "/admin/workspace");
  const sortedSkills = useMemo(
    () =>
      skills
        .filter((skill) => skill.eligible && !skill.disabled && !skill.blockedByAllowlist)
        .sort(compareSkills),
    [skills],
  );
  const activeSlashMatch = useMemo(
    () => parseActiveSlashMatch(text, composerSelection.start, composerSelection.end),
    [composerSelection.end, composerSelection.start, text],
  );
  const slashSuggestions = useMemo(
    () =>
      activeSlashMatch
        ? buildSlashSuggestions({
            query: activeSlashMatch.query,
            sortedSkills,
            commands: OPENCLAW_SLASH_COMMANDS,
          })
        : [],
    [activeSlashMatch, sortedSkills],
  );
  const activeSlashCommand = useMemo(() => {
    if (!activeSlashMatch) {
      return null;
    }

    return OPENCLAW_SLASH_COMMANDS.find((command) =>
      command.key === normalizeSlashSearchTerm(activeSlashMatch.commandName) ||
      command.aliases.some((alias) => normalizeSlashSearchTerm(alias) === normalizeSlashSearchTerm(activeSlashMatch.commandName)),
    ) ?? null;
  }, [activeSlashMatch]);
  const showSlashSuggestions =
    Boolean(activeSessionId) &&
    Boolean(activeSlashMatch?.isCursorInCommandToken) &&
    activeSlashMatch?.dismissKey !== dismissedSlashPanelKey;
  const showSlashHint =
    Boolean(activeSessionId) &&
    Boolean(activeSlashCommand) &&
    Boolean(activeSlashMatch) &&
    !activeSlashMatch?.isCursorInCommandToken &&
    activeSlashMatch?.argsText !== undefined;
  const mobileSlashSheetMaxHeight = useMemo(() => {
    if (!mobileViewportHeight) {
      return 320;
    }

    return Math.max(180, Math.min(360, Math.round(mobileViewportHeight * 0.46)));
  }, [mobileViewportHeight]);
  const activeRunBlocks = useMemo(() => {
    if (!activeRun || !isActiveSessionRunStatus(activeRun.status)) {
      return [];
    }

    return buildRenderableAssistantBlocks({
      content: activeRun.draftAssistantContent,
      run:
        activeRunHistory ?? {
          runId: activeRun.id,
          userMessageId: null,
          assistantMessageId: activeRun.assistantMessageId,
          assistantRenderMode: "markdown",
          status: activeRun.status,
          draftAssistantContent: activeRun.draftAssistantContent,
          errorMessage: activeRun.errorMessage,
          errorDiagnostic: null,
          startedAt: activeRun.startedAt,
          updatedAt: activeRun.updatedAt,
          steps: [],
          contentCheckpoints: [],
        },
      segmentation: activeRunSegmentation,
      streaming: true,
    });
  }, [activeRun, activeRunHistory, activeRunSegmentation]);
  const visibleDraftKey = activeRun
    ? `${activeRun.id}:${activeRun.draftAssistantContent}:${activeRun.status}:${runStateBySession[activeSessionId ?? ""] ?? "idle"}:${activeRunHistory?.steps.length ?? 0}:${activeRunSegmentation?.stepKeys.length ?? 0}:${activeRunBlocks.length}`
    : "idle";
  const renderableMessages = useMemo(() => {
    const runsInOrder = [...runHistory].sort(
      (left, right) => new Date(left.startedAt).valueOf() - new Date(right.startedAt).valueOf(),
    );
    const assistantRunByMessageId = new Map(
      runsInOrder
        .filter((run) => run.assistantMessageId)
        .map((run) => [run.assistantMessageId as string, run]),
    );
    const syntheticRunsByUserMessageId = new Map<string, ClientRunHistoryItem[]>();
    const syntheticRuns = runsInOrder.filter(
      (run) =>
        !run.assistantMessageId &&
        run.userMessageId &&
        !(activeStreamingRunId && run.runId === activeStreamingRunId),
    );

    for (const run of syntheticRuns) {
      const list = syntheticRunsByUserMessageId.get(run.userMessageId!) ?? [];
      list.push(run);
      syntheticRunsByUserMessageId.set(run.userMessageId!, list);
    }

    const next: RenderableMessage[] = [];
    for (const message of sessionMessages) {
      next.push({
        kind: "message",
        id: message.id,
        message,
        run: message.role === "ASSISTANT" ? assistantRunByMessageId.get(message.id) ?? null : null,
      });

      if (message.role === "USER") {
        for (const run of syntheticRunsByUserMessageId.get(message.id) ?? []) {
          next.push({
            kind: "synthetic-run",
            id: `draft-run:${run.runId}`,
            run,
          });
        }
      }
    }

    return next;
  }, [activeStreamingRunId, runHistory, sessionMessages]);
  const sidebarSessions = useMemo(
    () =>
      sessions.map((session) => ({
        session,
        isActive: session.id === activeSessionId,
        isBusy: isRunBusy(runStateBySession[session.id] ?? mapRunStatusToState(session.activeRun?.status)),
      })),
    [activeSessionId, runStateBySession, sessions],
  );
  const recentSidebarSessions = useMemo(
    () => sidebarSessions.filter(({ session }) => session.status === "ACTIVE"),
    [sidebarSessions],
  );
  const archivedSidebarSessions = useMemo(
    () => sidebarSessions.filter(({ session }) => session.status === "ARCHIVED"),
    [sidebarSessions],
  );
  const activeSessionLoaded = activeSessionId ? (loadedSessionIds[activeSessionId] ?? false) : true;
  const activeSessionHasRenderableContent =
    Boolean(pairing) || renderableMessages.length > 0 || Boolean(activeRun);
  const isEmptyState =
    (!activeSessionId || activeSessionLoaded) &&
    !pairing &&
    !activeRun &&
    sessionMessages.length === 0 &&
    !activeSessionReadOnly;
  const shouldCenterEmptyState = isEmptyState && !isPhoneViewport;
  const composerMode: ComposerMode = activeSessionId
    ? "active-session"
    : sessions.length === 0
      ? "bootstrap"
      : "create-session-only";

  const syncMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scroller = messagesScrollerRef.current;
    if (!scroller) {
      return;
    }

    isProgrammaticMessagesScrollRef.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    requestAnimationFrame(() => {
      isProgrammaticMessagesScrollRef.current = false;
    });
  }, []);

  const isNearMessagesBottom = useCallback(() => {
    const scroller = messagesScrollerRef.current;
    if (!scroller) {
      return true;
    }

    if (isBottomSentinelVisibleRef.current) {
      return true;
    }

    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }, []);

  useEffect(() => {
    showScrollToBottomRef.current = showScrollToBottom;
  }, [showScrollToBottom]);

  useLayoutEffect(() => {
    const composer = dockedComposerRef.current;
    if (!composer) {
      setDockedComposerHeight(0);
      return;
    }

    const updateHeight = () => {
      setDockedComposerHeight(composer.getBoundingClientRect().height);
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });

    observer.observe(composer);
    return () => observer.disconnect();
  }, [
    activeSessionId,
    activeSessionReadOnly,
    error,
    shouldCenterEmptyState,
    loading,
    pendingAttachments.length,
    selectedSkills.length,
    skillsOpen,
    showSlashSuggestions,
    text,
    uploading,
  ]);

  const setSessionRunState = useCallback((sessionId: string, nextState: RunState) => {
    setRunStateBySession((current) =>
      current[sessionId] === nextState
        ? current
        : {
            ...current,
            [sessionId]: nextState,
          },
    );
  }, []);

  const updateActiveRun = useCallback((sessionId: string, run: SessionRun | null) => {
    const previous = activeRunBySessionRef.current[sessionId];
    const runChanged = previous?.id !== run?.id || previous?.status !== run?.status;
    const seqAdvanced = (run?.lastEventSeq ?? 0) > (previous?.lastEventSeq ?? 0);
    if (runChanged || (seqAdvanced && ((run?.lastEventSeq ?? 0) <= 5 || (run?.lastEventSeq ?? 0) % 100 === 0))) {
      logChatShellDebug("[chat-debug][chat-shell] updateActiveRun", {
        sessionId,
        previousRunId: previous?.id ?? null,
        previousStatus: previous?.status ?? null,
        nextRunId: run?.id ?? null,
        nextStatus: run?.status ?? null,
        nextLastEventSeq: run?.lastEventSeq ?? null,
      });
    }

    if (previous?.id && previous.id !== run?.id) {
      eventSourcesRef.current[previous.id]?.close();
      delete eventSourcesRef.current[previous.id];
      if (reconnectTimersRef.current[previous.id]) {
        window.clearTimeout(reconnectTimersRef.current[previous.id]);
        delete reconnectTimersRef.current[previous.id];
      }
    }

    const bufferedPatch = bufferedRunPatchBySessionRef.current[sessionId];
    if (!run || bufferedPatch?.runId !== run.id) {
      delete bufferedRunPatchBySessionRef.current[sessionId];
      if (flushTimersBySessionRef.current[sessionId]) {
        window.clearTimeout(flushTimersBySessionRef.current[sessionId]);
        delete flushTimersBySessionRef.current[sessionId];
      }
    }

    activeRunBySessionRef.current = {
      ...activeRunBySessionRef.current,
      [sessionId]: run,
    };
    setActiveRunBySession((current) => ({
      ...current,
      [sessionId]: run,
    }));
  }, []);

  const updateSessionSummary = useCallback((next: Session) => {
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === next.id);
      if (index === -1) {
        return [next, ...current];
      }

      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  }, []);

  const syncSessionUrl = useCallback((sessionId: string | null) => {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    if (sessionId) {
      searchParams.set("session", sessionId);
    } else {
      searchParams.delete("session");
    }
    const query = searchParams.toString();
    const nextUrl = query ? `${pathname}?${query}` : pathname;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [pathname]);

  const initializeSessionState = useCallback((session: Session, options?: { composerText?: string }) => {
    updateSessionSummary(session);
    setActiveSessionId(session.id);
    setMessagesBySession((current) => ({ ...current, [session.id]: current[session.id] ?? [] }));
    setRunHistoryBySession((current) => ({ ...current, [session.id]: current[session.id] ?? [] }));
    setLoadedSessionIds((current) => ({ ...current, [session.id]: true }));
    updateActiveRun(session.id, null);
    setSessionRunState(session.id, "idle");
    setPendingAttachmentsBySession((current) => ({ ...current, [session.id]: current[session.id] ?? [] }));
    setSelectedSkillsBySession((current) => ({ ...current, [session.id]: current[session.id] ?? [] }));
    setComposerBySession((current) => ({
      ...current,
      [session.id]: options?.composerText ?? current[session.id] ?? "",
    }));
    setPairingBySession((current) => ({ ...current, [session.id]: null }));
    setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [session.id]: false }));
    setErrorBySession((current) => ({ ...current, [session.id]: null }));
    setShowScrollToBottom(false);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
    syncSessionUrl(session.id);
  }, [setSessionRunState, syncSessionUrl, updateActiveRun, updateSessionSummary]);

  const replaceRunHistory = useCallback((sessionId: string, runs: ClientRunHistoryItem[]) => {
    setRunHistoryBySession((current) => ({
      ...current,
      [sessionId]: runs,
    }));
  }, []);

  const refreshSessionContext = useCallback(
    async (sessionId: string) => {
      if (contextInFlightBySessionRef.current[sessionId]) {
        return;
      }

      const currentRun = activeRunBySessionRef.current[sessionId];
      if (currentRun && isActiveSessionRunStatus(currentRun.status)) {
        return;
      }

      contextInFlightBySessionRef.current[sessionId] = true;
      const requestVersion = (contextRequestVersionBySessionRef.current[sessionId] ?? 0) + 1;
      contextRequestVersionBySessionRef.current[sessionId] = requestVersion;
      setContextLoadingBySession((current) => ({ ...current, [sessionId]: true }));

      try {
        const response = await localeFetch(`/api/sessions/${sessionId}/context`, {
          method: "POST",
          cache: "no-store",
        });

        const payload = (await response.json().catch(() => ({}))) as {
          status?: "ok" | "busy" | "unavailable" | "pairing_required";
          usage?: SessionContextUsage;
          pairing?: PairingState;
        };

        if (contextRequestVersionBySessionRef.current[sessionId] !== requestVersion) {
          return;
        }

        if (!response.ok || payload.status === "unavailable") {
          setContextUsageBySession((current) => ({
            ...current,
            [sessionId]: {
              status: "unavailable",
              usage: null,
            },
          }));
          return;
        }

        if (payload.status === "busy") {
          return;
        }

        if (payload.status === "pairing_required" && payload.pairing) {
          const pairingState = payload.pairing;
          setPairingBySession((current) => ({ ...current, [sessionId]: pairingState }));
          setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
          setContextUsageBySession((current) => ({
            ...current,
            [sessionId]: {
              status: "pairing_required",
              usage: null,
            },
          }));
          return;
        }

        if (payload.status === "ok" && payload.usage) {
          setPairingBySession((current) => ({ ...current, [sessionId]: null }));
          setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
          const nextUsage = payload.usage;
          setContextUsageBySession((current) => ({
            ...current,
            [sessionId]: {
              status: "ok",
              usage: nextUsage,
            },
          }));
        }
      } finally {
        if (contextRequestVersionBySessionRef.current[sessionId] === requestVersion) {
          setContextLoadingBySession((current) => ({ ...current, [sessionId]: false }));
        }
        contextInFlightBySessionRef.current[sessionId] = false;
      }
    },
    [localeFetch],
  );

  const patchRunHistory = useCallback(
    (
      sessionId: string,
      runId: string,
      patch:
        | Partial<ClientRunHistoryItem>
        | ((current: ClientRunHistoryItem | null) => Partial<ClientRunHistoryItem> | null),
    ) => {
      setRunHistoryBySession((current) => {
        const runs = current[sessionId] ?? [];
        const existing = runs.find((item) => item.runId === runId) ?? null;
        const nextPatch = typeof patch === "function" ? patch(existing) : patch;

        if (!nextPatch) {
          return current;
        }

        if (!existing) {
          return current;
        }

        return {
          ...current,
          [sessionId]: upsertRunHistoryItem(runs, {
            runId,
            ...nextPatch,
          }),
        };
      });
    },
    [],
  );

  const getCurrentRunContent = useCallback((sessionId: string, fallbackRun: SessionRun) => {
    const bufferedPatch = bufferedRunPatchBySessionRef.current[sessionId];
    if (bufferedPatch?.runId === fallbackRun.id) {
      return bufferedPatch.draftAssistantContent;
    }

    const currentRun = activeRunBySessionRef.current[sessionId];
    if (currentRun?.id === fallbackRun.id) {
      return currentRun.draftAssistantContent;
    }

    return fallbackRun.draftAssistantContent;
  }, []);

  const captureRunSegmentation = useCallback(
    (sessionId: string, fallbackRun: SessionRun, entry: ClientRunActivityEntry | null) => {
      if (!entry) {
        return;
      }

      const stepKey = getActivityEntryRenderKey(entry);
      const fullText = getCurrentRunContent(sessionId, fallbackRun);
      setContentSegmentsByRunId((current) => updateRunSegmentation(current, fallbackRun.id, fullText, stepKey));
    },
    [getCurrentRunContent],
  );

  const flushBufferedRunPatch = useCallback((sessionId: string, fallbackRun: SessionRun) => {
    const patch = bufferedRunPatchBySessionRef.current[sessionId];
    if (!patch || patch.runId !== fallbackRun.id) {
      return;
    }

    const currentRun = activeRunBySessionRef.current[sessionId] ?? fallbackRun;
    updateActiveRun(sessionId, {
      ...currentRun,
      id: fallbackRun.id,
      status: "STREAMING",
      draftAssistantContent: patch.draftAssistantContent,
      lastEventSeq: patch.lastEventSeq,
      updatedAt: patch.updatedAt,
    });
  }, [updateActiveRun]);

  const scheduleBufferedRunPatchFlush = useCallback((sessionId: string, fallbackRun: SessionRun) => {
    if (flushTimersBySessionRef.current[sessionId]) {
      return;
    }

    flushTimersBySessionRef.current[sessionId] = window.setTimeout(() => {
      delete flushTimersBySessionRef.current[sessionId];
      flushBufferedRunPatch(sessionId, fallbackRun);
    }, activeSessionIdRef.current === sessionId ? 16 : 120);
  }, [flushBufferedRunPatch]);

  const subscribeToRun = useCallback((sessionId: string, run: SessionRun) => {
    if (typeof window === "undefined") {
      return;
    }

    if (!["STARTING", "STREAMING"].includes(run.status)) {
      logChatShellDebug("[chat-debug][chat-shell] skipping subscribe for terminal run", {
        sessionId,
        runId: run.id,
        status: run.status,
      });
      return;
    }

    if (eventSourcesRef.current[run.id]) {
      logChatShellDebug("[chat-debug][chat-shell] subscribe skipped because source already exists", {
        sessionId,
        runId: run.id,
        status: run.status,
      });
      return;
    }

    if (reconnectTimersRef.current[run.id]) {
      window.clearTimeout(reconnectTimersRef.current[run.id]);
      delete reconnectTimersRef.current[run.id];
    }

    const afterSeq = lastEventSeqByRunRef.current[run.id] ?? run.lastEventSeq ?? 0;
    let receivedEventCount = 0;
    logChatShellDebug("[chat-debug][chat-shell] opening EventSource", {
      sessionId,
      runId: run.id,
      runStatus: run.status,
      afterSeq,
      activeSessionId: activeSessionIdRef.current,
    });
    const source = new EventSource(
      `/api/sessions/${sessionId}/runs/${run.id}/stream?afterSeq=${encodeURIComponent(String(afterSeq))}&locale=${encodeURIComponent(locale)}`,
    );

    eventSourcesRef.current[run.id] = source;

    source.onmessage = (event) => {
      const payload = parseSsePayload(event.data);
      if (payload.type === "ping") {
        return;
      }

      receivedEventCount += 1;
      reconnectAttemptsRef.current[run.id] = 0;
      lastEventSeqByRunRef.current[run.id] = payload.seq;

      if (payload.type !== "delta" || receivedEventCount <= 5 || receivedEventCount % 50 === 0) {
        logChatShellDebug("[chat-debug][chat-shell] received stream event", {
          sessionId,
          runId: run.id,
          activeSessionId: activeRunBySessionRef.current[sessionId]?.id === run.id ? sessionId : null,
          payloadType: payload.type,
          seq: payload.seq,
          receivedEventCount,
        });
      }

      if (payload.type === "started") {
        setSessionRunState(sessionId, "streaming");
        updateActiveRun(sessionId, {
          ...(activeRunBySessionRef.current[sessionId] ?? run),
          id: run.id,
          status: "STREAMING",
          lastEventSeq: payload.seq,
        });
        const activityEntry = buildRunActivityEntryFromEvent(payload);
        if (activityEntry) {
          patchRunHistory(sessionId, run.id, (existing) =>
            existing
              ? {
                  status: "STREAMING",
                  updatedAt: payload.createdAt,
                  steps: mergeRunActivityEntries(existing.steps, activityEntry),
                }
              : null,
          );
        }
        return;
      }

      if (payload.type === "delta") {
        setSessionRunState(sessionId, "streaming");
        const currentRun = activeRunBySessionRef.current[sessionId] ?? run;
        const currentBufferedPatch = bufferedRunPatchBySessionRef.current[sessionId];
        const nextDraftAssistantContent =
          currentBufferedPatch?.runId === run.id
            ? `${currentBufferedPatch.draftAssistantContent}${payload.delta}`
            : `${currentRun.draftAssistantContent}${payload.delta}`;

        bufferedRunPatchBySessionRef.current[sessionId] = {
          runId: run.id,
          draftAssistantContent: nextDraftAssistantContent,
          lastEventSeq: payload.seq,
          updatedAt: payload.createdAt,
        };
        scheduleBufferedRunPatchFlush(sessionId, currentRun);
        return;
      }

      if (payload.type === "tool") {
        setSessionRunState(sessionId, "streaming");
        const activityEntry = buildRunActivityEntryFromEvent(payload);
        captureRunSegmentation(sessionId, run, activityEntry);
        if (activityEntry) {
          patchRunHistory(sessionId, run.id, (existing) =>
            existing
              ? {
                  status: "STREAMING",
                  updatedAt: payload.createdAt,
                  steps: mergeRunActivityEntries(existing.steps, activityEntry),
                }
              : null,
          );
        }
        return;
      }

      flushBufferedRunPatch(sessionId, run);
      source.close();
      delete eventSourcesRef.current[run.id];
      logChatShellDebug("[chat-debug][chat-shell] terminal stream event", {
        sessionId,
        runId: run.id,
        payloadType: payload.type,
        seq: payload.seq,
        receivedEventCount,
      });

      const terminalRunStatus =
        payload.type === "done"
          ? "COMPLETED"
          : payload.type === "aborted"
            ? "ABORTED"
            : "FAILED";
      const terminalRunError =
        payload.type === "done"
          ? null
          : payload.type === "aborted"
            ? payload.reason
            : payload.type === "pairing_required"
              ? payload.pairing.message
              : payload.error;
      if (payload.type === "done") {
        setSessionRunState(sessionId, "completed");
        setErrorBySession((current) => ({ ...current, [sessionId]: null }));
        setPairingBySession((current) => ({ ...current, [sessionId]: null }));
        setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
      } else if (payload.type === "aborted") {
        setSessionRunState(sessionId, "aborted");
        setErrorBySession((current) => ({
          ...current,
          [sessionId]: createSessionErrorState(payload.reason),
        }));
        setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
      } else if (payload.type === "pairing_required") {
        setSessionRunState(sessionId, "failed");
        setPairingBySession((current) => ({ ...current, [sessionId]: payload.pairing }));
        setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
        setContextUsageBySession((current) => ({
          ...current,
          [sessionId]: {
            status: "pairing_required",
            usage: null,
          },
        }));
        setErrorBySession((current) => ({
          ...current,
          [sessionId]: createSessionErrorState(payload.pairing.message, payload.pairing.diagnostic),
        }));
      } else {
        setSessionRunState(sessionId, "failed");
        setErrorBySession((current) => ({
          ...current,
          [sessionId]: createSessionErrorState(payload.error, payload.errorDiagnostic),
        }));
        setDeviceAuthorizationExpiredBySession((current) => ({
          ...current,
          [sessionId]: payload.errorCode === "gateway_device_token_expired",
        }));
      }

      const activityEntry = buildRunActivityEntryFromEvent(payload);
      captureRunSegmentation(sessionId, run, activityEntry);
      if (activityEntry) {
        patchRunHistory(sessionId, run.id, (existing) =>
          existing
            ? {
                status: terminalRunStatus,
                errorMessage: terminalRunError,
                updatedAt: payload.createdAt,
                steps: mergeRunActivityEntries(existing.steps, activityEntry),
              }
            : null,
        );
      }

      updateActiveRun(sessionId, null);
      void loadSessionRef.current(sessionId, false).finally(() => {
        if (payload.type !== "pairing_required") {
          void refreshSessionContext(sessionId);
        }
      });
    };

    source.onerror = () => {
      source.close();
      delete eventSourcesRef.current[run.id];

      const latestRun = activeRunBySessionRef.current[sessionId];
      if (!latestRun || latestRun.id !== run.id) {
        logChatShellDebug("[chat-debug][chat-shell] EventSource error ignored because run changed", {
          sessionId,
          runId: run.id,
          latestRunId: latestRun?.id ?? null,
        });
        return;
      }

      const nextAttempt = (reconnectAttemptsRef.current[run.id] ?? 0) + 1;
      reconnectAttemptsRef.current[run.id] = nextAttempt;

      if (nextAttempt > 5) {
        logChatShellDebug("[chat-debug][chat-shell] EventSource gave up reconnecting", {
          sessionId,
          runId: run.id,
          nextAttempt,
        });
        setSessionRunState(sessionId, "failed");
        setErrorBySession((current) => ({
          ...current,
          [sessionId]: createSessionErrorState(messages.chat.connectionLost),
        }));
        return;
      }

      logChatShellDebug("[chat-debug][chat-shell] EventSource scheduling reconnect", {
        sessionId,
        runId: run.id,
        nextAttempt,
        afterSeq: lastEventSeqByRunRef.current[run.id] ?? run.lastEventSeq ?? 0,
      });
      setSessionRunState(sessionId, "reconnecting");
      reconnectTimersRef.current[run.id] = window.setTimeout(() => {
        subscribeToRun(sessionId, latestRun);
      }, Math.min(1000 * nextAttempt, 4000));
    };
  }, [
    captureRunSegmentation,
    flushBufferedRunPatch,
    locale,
    messages.chat.connectionLost,
    patchRunHistory,
    refreshSessionContext,
    scheduleBufferedRunPatchFlush,
    setSessionRunState,
    updateActiveRun,
  ]);

  const loadSession = useCallback(async (sessionId: string, clearError = true) => {
    logChatShellDebug("[chat-debug][chat-shell] loading session", {
      sessionId,
      clearError,
      activeSessionId: activeSessionIdRef.current,
    });

    if (clearError) {
      setErrorBySession((current) => ({ ...current, [sessionId]: null }));
      setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
    }

    const response = await localeFetch(`/api/sessions/${sessionId}/messages`, {
      cache: "no-store",
    });

    if (!response.ok) {
      setErrorBySession((current) => ({
        ...current,
        [sessionId]: createSessionErrorState(messages.chat.failedToLoadSession),
      }));
      setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
      return;
    }

    const payload = (await response.json()) as {
      session: Session;
      messages: Message[];
      activeRun: SessionRun | null;
      runHistory: ClientRunHistoryItem[];
    };

    logChatShellDebug("[chat-debug][chat-shell] loaded session", {
      sessionId,
      activeSessionId: activeSessionIdRef.current,
      messageCount: payload.messages.length,
      activeRunId: payload.activeRun?.id ?? null,
      activeRunStatus: payload.activeRun?.status ?? null,
      activeRunAssistantMessageId: payload.activeRun?.assistantMessageId ?? null,
      activeRunLastEventSeq: payload.activeRun?.lastEventSeq ?? null,
    });

    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: payload.messages,
    }));
    replaceRunHistory(sessionId, payload.runHistory);
    setLoadedSessionIds((current) => ({ ...current, [sessionId]: true }));
    updateSessionSummary(payload.session);
    const nextActiveRun = payload.activeRun && isActiveSessionRunStatus(payload.activeRun.status)
      ? payload.activeRun
      : null;
    updateActiveRun(sessionId, nextActiveRun);

    const nextState = nextActiveRun ? mapRunStatusToState(nextActiveRun.status) : "idle";
    setSessionRunState(sessionId, nextState);

    if (!nextActiveRun) {
      setPairingBySession((current) => ({ ...current, [sessionId]: null }));
      setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [sessionId]: false }));
      const contextState = contextUsageBySession[sessionId];
      if (payload.session.status !== "ARCHIVED" && (!contextState || contextState.status === "idle")) {
        void refreshSessionContext(sessionId);
      }
      return;
    }

    lastEventSeqByRunRef.current[nextActiveRun.id] = nextActiveRun.lastEventSeq;

    subscribeToRun(sessionId, nextActiveRun);
  }, [contextUsageBySession, localeFetch, messages.chat.failedToLoadSession, refreshSessionContext, replaceRunHistory, setSessionRunState, subscribeToRun, updateActiveRun, updateSessionSummary]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    bootstrapComposerTextRef.current = bootstrapComposerText;
  }, [bootstrapComposerText]);

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  useEffect(() => {
    if (!renameSessionId || !renameInputRef.current) {
      return;
    }

    renameInputRef.current.focus();
    renameInputRef.current.select();
  }, [renameSessionId]);

  useEffect(() => {
    if (!shareSessionId || shareAccessMode !== "PASSWORD" || !sharePasswordInputRef.current) {
      return;
    }

    sharePasswordInputRef.current.focus();
  }, [shareAccessMode, shareSessionId]);

  const loadSkills = useCallback(async (force = false) => {
    if (skillsLoading || (skillsFetched && !force)) {
      return;
    }

    setSkillsLoading(true);
    setSkillsError(null);

    try {
      const response = await localeFetch("/api/skills", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as {
        skills?: Skill[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? messages.chat.skillsUnavailable);
      }

      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      setSkillsFetched(true);
    } catch (loadError) {
      setSkillsError(loadError instanceof Error ? loadError.message : messages.chat.skillsUnavailable);
    } finally {
      setSkillsLoading(false);
    }
  }, [localeFetch, messages.chat.skillsUnavailable, skillsFetched, skillsLoading]);

  const ensureInitialSession = useCallback(async () => {
    if (activeSessionIdRef.current) {
      return activeSessionIdRef.current;
    }

    if (bootstrapPromiseRef.current) {
      return bootstrapPromiseRef.current;
    }

    setBootstrapPending(true);
    setBootstrapError(null);

    const request = (async () => {
      const response = await localeFetch("/api/sessions", { method: "POST" }).catch(() => null);

      if (!response) {
        setBootstrapError(messages.common.networkError);
        return null;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setBootstrapError(payload.error ?? messages.chat.failedToCreateSession);
        return null;
      }

      const payload = (await response.json()) as { session: Session };
      const composerText = bootstrapComposerTextRef.current;
      initializeSessionState(payload.session, { composerText });
      setBootstrapError(null);
      return payload.session.id;
    })().finally(() => {
      bootstrapPromiseRef.current = null;
      setBootstrapPending(false);
    });

    bootstrapPromiseRef.current = request;
    return request;
  }, [initializeSessionState, localeFetch, messages.chat.failedToCreateSession, messages.common.networkError]);

  useEffect(() => {
    if (!skillsOpen) {
      return;
    }

    if (!skillsFetched) {
      void loadSkills();
    }
  }, [loadSkills, skillsFetched, skillsOpen]);

  useEffect(() => {
    if (!skillsOpen) {
      return;
    }

    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSkillsOpen(false);
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [skillsOpen]);

  useEffect(() => {
    if (!skillsOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (skillsPopoverRef.current?.contains(target) || mobileSkillsSheetRef.current?.contains(target)) {
        return;
      }

      setSkillsOpen(false);
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
    };
  }, [skillsOpen]);

  useEffect(() => {
    if (activeSessionId || sessions.length > 0 || bootstrapError || bootstrapPromiseRef.current) {
      return;
    }

    void ensureInitialSession();
  }, [activeSessionId, bootstrapError, ensureInitialSession, sessions.length]);

  useEffect(() => {
    if (!activeSessionId || activeSessionReadOnly) {
      setSkillsOpen(false);
    }
  }, [activeSessionId, activeSessionReadOnly]);

  const loadMoreSessions = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) {
      return;
    }

    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const response = await localeFetch(
        `/api/sessions?limit=${pageSize}&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error(messages.chat.failedToLoadMoreSessions);
      }

      const payload = (await response.json()) as {
        sessions: Session[];
        pageInfo: SessionsPageInfo;
      };

      setSessions((current) => {
        const incomingById = new Map(payload.sessions.map((session) => [session.id, session]));
        const next = current.map((session) => incomingById.get(session.id) ?? session);
        const seen = new Set(next.map((session) => session.id));

        for (const session of payload.sessions) {
          if (!seen.has(session.id)) {
            next.push(session);
            seen.add(session.id);
          }
        }

        return next;
      });
      setHasMore(payload.pageInfo.hasMore);
      setNextCursor(payload.pageInfo.nextCursor);
    } catch (loadError) {
      setLoadMoreError(loadError instanceof Error ? loadError.message : messages.chat.failedToLoadMoreSessions);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, localeFetch, messages.chat.failedToLoadMoreSessions, nextCursor, pageSize]);

  useEffect(() => {
    const root = sessionsScrollerRef.current;
    const target = loadMoreSentinelRef.current;

    if (!root || !target || loadingMore || !hasMore) {
      return;
    }

    if (!drawerOpen && typeof window !== "undefined" && window.innerWidth < 1024) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMoreSessions();
        }
      },
      {
        root,
        rootMargin: "0px 0px 120px 0px",
        threshold: 0,
      },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [drawerOpen, hasMore, loadingMore, loadMoreSessions, nextCursor, sessions.length]);

  useLayoutEffect(() => {
    if (!shouldSnapMessagesToBottomRef.current && !shouldStickMessagesToBottomRef.current) {
      return;
    }

    if (
      shouldSnapMessagesToBottomRef.current &&
      activeSessionId &&
      !activeSessionLoaded &&
      !activeSessionHasRenderableContent
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      syncMessagesToBottom();
      shouldSnapMessagesToBottomRef.current = false;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeSessionHasRenderableContent,
    activeSessionId,
    activeSessionLoaded,
    renderableMessages,
    syncMessagesToBottom,
    visibleDraftKey,
  ]);

  useLayoutEffect(() => {
    const scroller = messagesScrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") {
      return;
    }

    let frameId = 0;
    const observer = new ResizeObserver(() => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        if (!activeSessionHasRenderableContent) {
          isAutoScrollingToBottomRef.current = false;
          setShowScrollToBottom(false);
          return;
        }

        if (!showScrollToBottomRef.current) {
          syncMessagesToBottom();
          return;
        }

        const nearBottom = isNearMessagesBottom();
        if (isAutoScrollingToBottomRef.current && !nearBottom) {
          return;
        }

        if (nearBottom) {
          isAutoScrollingToBottomRef.current = false;
        }
        shouldStickMessagesToBottomRef.current = loading && nearBottom;
        setShowScrollToBottom(!nearBottom);
      });
    });

    observer.observe(scroller);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [activeSessionHasRenderableContent, isNearMessagesBottom, loading, syncMessagesToBottom]);

  useEffect(() => {
    const scroller = messagesScrollerRef.current;
    const sentinel = messagesBottomSentinelRef.current;
    if (!scroller || !sentinel || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nearBottom = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.99);
        isBottomSentinelVisibleRef.current = nearBottom;
        if (isAutoScrollingToBottomRef.current && !nearBottom) {
          return;
        }

        if (nearBottom) {
          isAutoScrollingToBottomRef.current = false;
        }
        shouldStickMessagesToBottomRef.current = loading && nearBottom;
        setShowScrollToBottom(activeSessionHasRenderableContent && !nearBottom);
      },
      {
        root: scroller,
        threshold: [0.99, 1],
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeSessionHasRenderableContent, activeSessionId, loading, visibleDraftKey]);

  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";

    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computedStyle.lineHeight);
    const paddingHeight =
      Number.parseFloat(computedStyle.paddingTop) + Number.parseFloat(computedStyle.paddingBottom);
    const borderHeight =
      Number.parseFloat(computedStyle.borderTopWidth) + Number.parseFloat(computedStyle.borderBottomWidth);
    const maxHeight = lineHeight * 10 + paddingHeight + borderHeight;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";

    if (pendingComposerSelectionRef.current) {
      const { start, end } = pendingComposerSelectionRef.current;
      textarea.setSelectionRange(start, end);
      pendingComposerSelectionRef.current = null;
      setComposerSelection({ start, end });
    }
  }, [activeSessionId, text]);

  useEffect(() => {
    if (initialActiveSessionId && initialActiveRun) {
      subscribeToRun(initialActiveSessionId, initialActiveRun);
    }

    const eventSources = eventSourcesRef.current;
    const reconnectTimers = reconnectTimersRef.current;

    return () => {
      for (const source of Object.values(eventSources)) {
        source.close();
      }
      for (const timer of Object.values(reconnectTimers)) {
        window.clearTimeout(timer);
      }
    };
  }, [initialActiveRun, initialActiveSessionId, subscribeToRun]);

  useEffect(() => {
    if (!initialActiveSessionId || initialActiveRun) {
      return;
    }

    const initialSession = sessions.find((session) => session.id === initialActiveSessionId);
    if (initialSession?.status === "ARCHIVED") {
      return;
    }

    const contextState = contextUsageBySession[initialActiveSessionId];
    if (contextState && contextState.status !== "idle") {
      return;
    }

    void refreshSessionContext(initialActiveSessionId);
  }, [
    contextUsageBySession,
    initialActiveRun,
    initialActiveSessionId,
    refreshSessionContext,
    sessions,
  ]);

  useEffect(() => {
    if (!activeSessionId || !activeSessionLoaded || activeSessionReadOnly || contextLoading) {
      return;
    }

    if (activeRun && isActiveSessionRunStatus(activeRun.status)) {
      return;
    }

    const contextState = contextUsageBySession[activeSessionId];
    if (contextState && contextState.status !== "idle") {
      return;
    }

    void refreshSessionContext(activeSessionId);
  }, [
    activeRun,
    activeSessionId,
    activeSessionLoaded,
    activeSessionReadOnly,
    contextLoading,
    contextUsageBySession,
    refreshSessionContext,
  ]);

  useEffect(() => {
    if (!showSlashSuggestions || skillsFetched || skillsLoading) {
      return;
    }

    void loadSkills();
  }, [loadSkills, showSlashSuggestions, skillsFetched, skillsLoading]);

  useEffect(() => {
    const currentLength = composerTextareaRef.current?.value.length ?? 0;
    setComposerSelection({ start: currentLength, end: currentLength });
    setDismissedSlashPanelKey(null);
  }, [activeSessionId]);

  useEffect(() => {
    setHighlightedSlashIndex(0);
  }, [activeSlashMatch?.dismissKey, activeSlashMatch?.query, slashSuggestions.length]);

  useEffect(() => {
    if (!dismissedSlashPanelKey) {
      return;
    }

    if (!activeSlashMatch) {
      setDismissedSlashPanelKey(null);
      return;
    }

    if (activeSlashMatch.dismissKey !== dismissedSlashPanelKey) {
      setDismissedSlashPanelKey(null);
    }
  }, [activeSlashMatch, dismissedSlashPanelKey]);

  useEffect(() => {
    if (showSlashSuggestions && skillsOpen) {
      setSkillsOpen(false);
    }
  }, [showSlashSuggestions, skillsOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 639px)");
    const updatePhoneViewport = () => {
      setIsPhoneViewport(mediaQuery.matches);
    };

    updatePhoneViewport();
    mediaQuery.addEventListener("change", updatePhoneViewport);

    return () => {
      mediaQuery.removeEventListener("change", updatePhoneViewport);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateViewportHeight = () => {
      const nextHeight = window.visualViewport?.height ?? window.innerHeight;
      setMobileViewportHeight(nextHeight);
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    window.visualViewport?.addEventListener("resize", updateViewportHeight);

    return () => {
      window.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
    };
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    logChatShellDebug("[chat-debug][chat-shell] selecting session", {
      fromSessionId: activeSessionId,
      toSessionId: sessionId,
      alreadyLoaded: Boolean(loadedSessionIds[sessionId]),
    });
    setShowScrollToBottom(false);
    setActiveSessionId(sessionId);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
    syncSessionUrl(sessionId);

    if (!loadedSessionIds[sessionId]) {
      await loadSession(sessionId);
      return;
    }

    const run = activeRunBySessionRef.current[sessionId];
    if (run && isActiveSessionRunStatus(run.status)) {
      await loadSession(sessionId, false);
      return;
    }

    if (run) {
      flushBufferedRunPatch(sessionId, run);
    }
    if (run && isActiveSessionRunStatus(run.status)) {
      subscribeToRun(sessionId, run);
      return;
    }

    const selectedSession = sessions.find((candidate) => candidate.id === sessionId);
    const contextState = contextUsageBySession[sessionId];
    if (selectedSession?.status !== "ARCHIVED" && (!contextState || contextState.status === "idle")) {
      void refreshSessionContext(sessionId);
    }
  }, [activeSessionId, contextUsageBySession, flushBufferedRunPatch, loadedSessionIds, loadSession, refreshSessionContext, sessions, subscribeToRun, syncSessionUrl]);

  const createSession = useCallback(async () => {
    if (!activeSessionId && sessions.length === 0) {
      await ensureInitialSession();
      return;
    }

    logChatShellDebug("[chat-debug][chat-shell] creating session", {
      currentActiveSessionId: activeSessionId,
    });
    setErrorBySession((current) => ({
      ...current,
      [activeSessionId ?? ""]: null,
    }));

    const response = await localeFetch("/api/sessions", { method: "POST" });
    if (!response.ok) {
      if (activeSessionId) {
        setErrorBySession((current) => ({
          ...current,
          [activeSessionId]: createSessionErrorState(messages.chat.failedToCreateSession),
        }));
      }
      return;
    }

    const payload = (await response.json()) as { session: Session };
    logChatShellDebug("[chat-debug][chat-shell] created session", {
      previousActiveSessionId: activeSessionId,
      newSessionId: payload.session.id,
    });
    initializeSessionState(payload.session);
  }, [activeSessionId, ensureInitialSession, initializeSessionState, localeFetch, messages.chat.failedToCreateSession, sessions.length]);

  const openRenameModal = useCallback((session: Session) => {
    if (isSidebarCollapsed || session.status === "ARCHIVED") {
      return;
    }

    setRenameSessionId(session.id);
    setRenameTitle(session.title);
    setRenameError(null);
    setRenameSubmitting(false);
  }, [isSidebarCollapsed]);

  const openShareModal = useCallback(async (session: Session) => {
    setShareSessionId(session.id);
    setShareState(null);
    setShareAccessMode("PUBLIC");
    setSharePassword("");
    setShareError(null);
    setShareLoading(true);
    setShareSubmitting(false);

    const response = await localeFetch(`/api/sessions/${session.id}/share`).catch(() => null);
    if (!response) {
      setShareError(messages.common.networkError);
      setShareLoading(false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      try {
        const payload = JSON.parse(rawText) as { error?: string };
        setShareError(payload.error ?? messages.chat.shareFailedToLoad);
      } catch {
        setShareError(messages.chat.shareFailedToLoad);
      }
      setShareLoading(false);
      return;
    }

    const payload = JSON.parse(rawText) as { share: SessionShare };
    setShareState(payload.share);
    setShareAccessMode(payload.share.accessMode ?? "PUBLIC");
    setShareLoading(false);
  }, [localeFetch, messages.chat.shareFailedToLoad, messages.common.networkError]);

  const closeRenameModal = useCallback(() => {
    if (renameSubmitting) {
      return;
    }

    setRenameSessionId(null);
    setRenameTitle("");
    setRenameError(null);
  }, [renameSubmitting]);

  const closeShareModal = useCallback(() => {
    if (shareSubmitting) {
      return;
    }

    setShareSessionId(null);
    setShareState(null);
    setShareAccessMode("PUBLIC");
    setSharePassword("");
    setShareError(null);
    setShareLoading(false);
  }, [shareSubmitting]);

  async function submitRenameSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!renameTargetSession || renameSubmitting) {
      return;
    }

    const normalizedTitle = renameTitle.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!normalizedTitle) {
      setRenameError(messages.chat.titleRequired);
      return;
    }

    setRenameSubmitting(true);
    setRenameError(null);

    const response = await localeFetch(`/api/sessions/${renameTargetSession.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: normalizedTitle }),
    }).catch(() => null);

    if (!response) {
      setRenameError(messages.common.networkError);
      setRenameSubmitting(false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      let errorMessage: string = messages.chat.failedToRenameSession;

      if (rawText) {
        try {
          const payload = JSON.parse(rawText) as { error?: string };
          errorMessage = payload.error ?? errorMessage;
        } catch {
          errorMessage = messages.chat.failedToRenameSession;
        }
      }

      setRenameError(errorMessage);
      setRenameSubmitting(false);
      return;
    }

    const payload = JSON.parse(rawText) as { session: Session };
    updateSessionSummary(payload.session);
    setRenameSubmitting(false);
    setRenameSessionId(null);
    setRenameTitle("");
    setRenameError(null);
  }

  async function submitShareSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!shareTargetSession || shareSubmitting) {
      return;
    }

    if (shareAccessMode === "PASSWORD" && !sharePassword.trim() && !shareState?.enabled) {
      setShareError(messages.share.passwordRequired);
      return;
    }

    setShareSubmitting(true);
    setShareError(null);

    const response = await localeFetch(`/api/sessions/${shareTargetSession.id}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        accessMode: shareAccessMode,
        password: sharePassword.trim() || undefined,
      }),
    }).catch(() => null);

    if (!response) {
      setShareError(messages.common.networkError);
      setShareSubmitting(false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      try {
        const payload = JSON.parse(rawText) as { error?: string };
        setShareError(payload.error ?? messages.chat.shareFailedToUpdate);
      } catch {
        setShareError(messages.chat.shareFailedToUpdate);
      }
      setShareSubmitting(false);
      return;
    }

    const payload = JSON.parse(rawText) as { share: SessionShare };
    setShareState(payload.share);
    setShareAccessMode(payload.share.accessMode ?? shareAccessMode);
    setSharePassword("");
    setShareSubmitting(false);
  }

  async function stopSharingSession() {
    if (!shareTargetSession || shareSubmitting) {
      return;
    }

    setShareSubmitting(true);
    setShareError(null);

    const response = await localeFetch(`/api/sessions/${shareTargetSession.id}/share`, {
      method: "DELETE",
    }).catch(() => null);

    if (!response) {
      setShareError(messages.common.networkError);
      setShareSubmitting(false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      try {
        const payload = JSON.parse(rawText) as { error?: string };
        setShareError(payload.error ?? messages.chat.shareFailedToUpdate);
      } catch {
        setShareError(messages.chat.shareFailedToUpdate);
      }
      setShareSubmitting(false);
      return;
    }

    const payload = JSON.parse(rawText) as { share: SessionShare };
    setShareState(payload.share);
    setShareAccessMode("PUBLIC");
    setSharePassword("");
    setShareSubmitting(false);
  }

  async function uploadFiles(files: FileList | File[] | Iterable<File> | null | undefined) {
    const filesToUpload = normalizeUploadFiles(files);
    if (!filesToUpload.length || !activeSessionId || activeSessionReadOnly) {
      return;
    }

    setUploadingBySession((current) => ({ ...current, [activeSessionId]: true }));
    setErrorBySession((current) => ({ ...current, [activeSessionId]: null }));
    const nextAttachments: Attachment[] = [];

    for (const file of filesToUpload) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sessionId", activeSessionId);

      const response = await localeFetch("/api/attachments", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setErrorBySession((current) => ({
          ...current,
          [activeSessionId]: createSessionErrorState(
            payload.error ?? t(messages.chat.uploadFailedForFile, { fileName: file.name }),
          ),
        }));
        continue;
      }

      const payload = (await response.json()) as { attachment: Attachment };
      nextAttachments.push(payload.attachment);
    }

    setPendingAttachmentsBySession((current) => ({
      ...current,
      [activeSessionId]: [...(current[activeSessionId] ?? []), ...nextAttachments],
    }));
    setUploadingBySession((current) => ({ ...current, [activeSessionId]: false }));
  }

  async function attachLazycatPaths(detail: LazycatPickerSubmitDetail) {
    if (!activeSessionId || activeSessionReadOnly) {
      return;
    }

    setUploadingBySession((current) => ({ ...current, [activeSessionId]: true }));
    setErrorBySession((current) => ({ ...current, [activeSessionId]: null }));

    const response = await localeFetch("/api/attachments/lazycat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: activeSessionId,
        pickerDetail: detail,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setErrorBySession((current) => ({
        ...current,
        [activeSessionId]: createSessionErrorState(payload.error ?? messages.chat.lazycatEmptySelection),
      }));
      setUploadingBySession((current) => ({ ...current, [activeSessionId]: false }));
      return;
    }

    const payload = (await response.json()) as { attachments: Attachment[] };
    setPendingAttachmentsBySession((current) => ({
      ...current,
      [activeSessionId]: [...(current[activeSessionId] ?? []), ...payload.attachments],
    }));
    setUploadingBySession((current) => ({ ...current, [activeSessionId]: false }));
  }

  const handleLazycatAvailabilityChange = useCallback((available: boolean) => {
    setLazycatFilePickerAvailable(available);
    if (!available) {
      setLazycatPickerOpen(false);
    }
  }, []);

  const handleLazycatError = useCallback((message: string) => {
    if (!activeSessionId) {
      return;
    }

    setErrorBySession((current) => ({
      ...current,
      [activeSessionId]: createSessionErrorState(message || messages.chat.lazycatUnavailable),
    }));
  }, [activeSessionId, messages.chat.lazycatUnavailable]);

  async function handleLazycatSubmit(detail: LazycatPickerSubmitDetail) {
    await attachLazycatPaths(detail);
  }

  async function submitActiveMessage() {
    const bootstrapText = bootstrapComposerTextRef.current;
    let targetSessionId = activeSessionId;

    if (!targetSessionId) {
      targetSessionId = await ensureInitialSession();
    }

    if (!targetSessionId || loading || activeSessionReadOnly) {
      return;
    }

    const currentText = activeSessionId ? composerBySession[activeSessionId] ?? "" : bootstrapText;
    const trimmedText = currentText.trim();
    const selectedAttachments = pendingAttachmentsBySession[targetSessionId] ?? [];
    const selectedSkillSnapshots = selectedSkillsBySession[targetSessionId] ?? [];

    if (!trimmedText && selectedAttachments.length === 0 && selectedSkillSnapshots.length === 0) {
      return;
    }

    const inputText = trimmedText ? currentText : "";
    const attachmentIds = selectedAttachments.map((attachment) => attachment.id);
    const skillKeys = selectedSkillSnapshots.map((skill) => skill.key);
    const clientRequestId = uuidv4();
    const optimisticRun: SessionRun = {
      id: `pending:${clientRequestId}`,
      status: "STARTING",
      clientRequestId,
      assistantMessageId: null,
      lastEventSeq: 0,
      draftAssistantContent: "",
      errorMessage: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    logChatShellDebug("[chat-debug][chat-shell] sending message", {
      sessionId: targetSessionId,
      clientRequestId,
      textLength: inputText.length,
      attachmentCount: selectedAttachments.length,
      skillCount: selectedSkillSnapshots.length,
    });

    setMessagesBySession((current) => ({
      ...current,
      [targetSessionId]: [
        ...(current[targetSessionId] ?? []),
        {
          id: `local-user:${clientRequestId}`,
          role: "USER",
          content: inputText,
          createdAt: new Date().toISOString(),
          skills: selectedSkillSnapshots,
          attachments: selectedAttachments,
        },
      ],
    }));
    setComposerBySession((current) => ({ ...current, [targetSessionId]: "" }));
    setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: [] }));
    setSelectedSkillsBySession((current) => ({ ...current, [targetSessionId]: [] }));
    setSessionRunState(targetSessionId, "starting");
    setErrorBySession((current) => ({ ...current, [targetSessionId]: null }));
    setDeviceAuthorizationExpiredBySession((current) => ({ ...current, [targetSessionId]: false }));
    setPairingBySession((current) => ({ ...current, [targetSessionId]: null }));
    updateActiveRun(targetSessionId, optimisticRun);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = true;
    setShowScrollToBottom(false);

    const response = await localeFetch(`/api/sessions/${targetSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: inputText,
        attachmentIds,
        skillKeys,
        clientRequestId,
      }),
    }).catch(() => null);

    if (!response) {
      logChatShellDebug("[chat-debug][chat-shell] send failed before response", {
        sessionId: targetSessionId,
        clientRequestId,
        error: messages.common.networkError,
      });
      setSessionRunState(targetSessionId, "failed");
      setErrorBySession((current) => ({
        ...current,
        [targetSessionId]: createSessionErrorState(messages.common.networkError),
      }));
      setComposerBySession((current) => ({ ...current, [targetSessionId]: inputText }));
      setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: selectedAttachments }));
      setSelectedSkillsBySession((current) => ({ ...current, [targetSessionId]: selectedSkillSnapshots }));
      await loadSession(targetSessionId, false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      let errorMessage: string = messages.chat.failedToSend;
      if (rawText) {
        try {
          const payload = JSON.parse(rawText) as { error?: string };
          errorMessage = payload.error ?? errorMessage;
        } catch {
          errorMessage = messages.chat.failedToSend;
        }
      }

      logChatShellDebug("[chat-debug][chat-shell] send failed with response", {
        sessionId: targetSessionId,
        clientRequestId,
        errorMessage,
        status: response.status,
      });
      setSessionRunState(targetSessionId, "failed");
      setErrorBySession((current) => ({
        ...current,
        [targetSessionId]: createSessionErrorState(errorMessage),
      }));
      setComposerBySession((current) => ({ ...current, [targetSessionId]: inputText }));
      setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: selectedAttachments }));
      setSelectedSkillsBySession((current) => ({ ...current, [targetSessionId]: selectedSkillSnapshots }));
      await loadSession(targetSessionId, false);
      return;
    }

    const payload = JSON.parse(rawText) as {
      created: boolean;
      run: SessionRun | null;
      session: Session;
    };

    logChatShellDebug("[chat-debug][chat-shell] send response received", {
      sessionId: targetSessionId,
      currentActiveSessionId: activeSessionId,
      clientRequestId,
      created: payload.created,
      runId: payload.run?.id ?? null,
      runStatus: payload.run?.status ?? null,
      runLastEventSeq: payload.run?.lastEventSeq ?? null,
    });

    updateSessionSummary(payload.session);

    if (!payload.run) {
      updateActiveRun(targetSessionId, null);
      setSessionRunState(targetSessionId, "idle");
      return;
    }

    const run = payload.run;
    updateActiveRun(targetSessionId, run);
    setSessionRunState(targetSessionId, mapRunStatusToState(run.status));
    lastEventSeqByRunRef.current[run.id] = run.lastEventSeq;
    await loadSession(targetSessionId, false);
  }

  function syncComposerSelectionFromElement(element: HTMLTextAreaElement) {
    setComposerSelection({
      start: element.selectionStart ?? 0,
      end: element.selectionEnd ?? 0,
    });
  }

  function updateComposerText(nextText: string, selection: ComposerSelection) {
    if (!activeSessionId && composerMode !== "bootstrap") {
      return;
    }

    pendingComposerSelectionRef.current = selection;
    if (activeSessionId) {
      setComposerBySession((current) => ({ ...current, [activeSessionId]: nextText }));
      return;
    }

    setBootstrapComposerText(nextText);
    if (bootstrapError) {
      setBootstrapError(null);
    }
  }

  function handleSelectSlashSuggestion(item: SlashSuggestionItem) {
    if (!activeSessionId || !activeSlashMatch) {
      return;
    }

    setDismissedSlashPanelKey(null);
    setSkillsOpen(false);

    if (item.kind === "skill") {
      handleToggleSkillSelection(item.skill);
      const nextText = replaceComposerRange(text, activeSlashMatch.slashStart, activeSlashMatch.tokenEnd, "");
      updateComposerText(nextText, {
        start: activeSlashMatch.slashStart,
        end: activeSlashMatch.slashStart,
      });
      composerTextareaRef.current?.focus();
      return;
    }

    const nextText = replaceComposerRange(
      text,
      activeSlashMatch.slashStart,
      activeSlashMatch.tokenEnd,
      item.insertText,
    );
    const nextCursor = activeSlashMatch.slashStart + item.insertText.length;
    updateComposerText(nextText, { start: nextCursor, end: nextCursor });
    composerTextareaRef.current?.focus();
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (showSlashSuggestions && slashSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedSlashIndex((current) => (current + 1) % slashSuggestions.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedSlashIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
    }

    if (event.key === "Escape" && showSlashSuggestions && activeSlashMatch) {
      event.preventDefault();
      setDismissedSlashPanelKey(activeSlashMatch.dismissKey);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    if (showSlashSuggestions && slashSuggestions[highlightedSlashIndex]) {
      event.preventDefault();
      handleSelectSlashSuggestion(slashSuggestions[highlightedSlashIndex]);
      return;
    }

    event.preventDefault();
    void submitActiveMessage();
  }

  const abortSession = useCallback(async () => {
    if (!activeSessionId) {
      return;
    }

    shouldStickMessagesToBottomRef.current = false;
    setShowScrollToBottom(false);
    await localeFetch(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setSessionRunState(activeSessionId, "aborted");
  }, [activeSessionId, localeFetch, setSessionRunState]);

  const handleMessagesScroll = useCallback(() => {
    if (isProgrammaticMessagesScrollRef.current) {
      return;
    }

    const nearBottom = isNearMessagesBottom();
    if (isAutoScrollingToBottomRef.current && !nearBottom) {
      return;
    }

    if (nearBottom) {
      isAutoScrollingToBottomRef.current = false;
    }
    shouldStickMessagesToBottomRef.current = loading && nearBottom;
    setShowScrollToBottom(!nearBottom);
  }, [isNearMessagesBottom, loading]);

  const handleScrollToBottomClick = useCallback(() => {
    isAutoScrollingToBottomRef.current = true;
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = loading;
    syncMessagesToBottom("smooth");
  }, [loading, syncMessagesToBottom]);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const handleOpenDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  const handleCollapseSidebar = useCallback(() => {
    setIsSidebarCollapsed(true);
  }, []);

  const handleExpandSidebar = useCallback(() => {
    setIsSidebarCollapsed(false);
  }, []);

  const handleCreateSessionClick = useCallback(() => {
    void createSession();
  }, [createSession]);

  const handleSelectSession = useCallback((sessionId: string) => {
    void selectSession(sessionId);
  }, [selectSession]);

  const handleLoadMoreSessions = useCallback(() => {
    void loadMoreSessions();
  }, [loadMoreSessions]);

  const handleToggleSkills = useCallback(() => {
    if (!activeSessionId || uploading || loading || activeSessionReadOnly) {
      return;
    }

    if (activeSlashMatch) {
      setDismissedSlashPanelKey(activeSlashMatch.dismissKey);
    }
    setSkillsOpen((current) => !current);
  }, [activeSessionId, activeSessionReadOnly, activeSlashMatch, loading, uploading]);

  const handleRetryLoadSkills = useCallback(() => {
    void loadSkills(true);
  }, [loadSkills]);

  const handleToggleSkillSelection = useCallback((skill: Skill) => {
    if (!activeSessionId) {
      return;
    }

    setSelectedSkillsBySession((current) => {
      const sessionSkills = current[activeSessionId] ?? [];
      const existing = sessionSkills.find((item) => item.key === skill.key);

      if (existing) {
        return {
          ...current,
          [activeSessionId]: sessionSkills.filter((item) => item.key !== skill.key),
        };
      }

      return {
        ...current,
        [activeSessionId]: [
          ...sessionSkills,
          {
            key: skill.key,
            name: skill.name,
            source: skill.source,
            bundled: skill.bundled,
          },
        ],
      };
    });
  }, [activeSessionId]);

  const handleRemoveSelectedSkill = useCallback((skillKey: string) => {
    if (!activeSessionId) {
      return;
    }

    setSelectedSkillsBySession((current) => ({
      ...current,
      [activeSessionId]: (current[activeSessionId] ?? []).filter((skill) => skill.key !== skillKey),
    }));
  }, [activeSessionId]);

  const handleRemovePendingAttachment = useCallback((attachmentId: string) => {
    if (!activeSessionId) {
      return;
    }

    setPendingAttachmentsBySession((current) => ({
      ...current,
      [activeSessionId]: (current[activeSessionId] ?? []).filter((attachment) => attachment.id !== attachmentId),
    }));
  }, [activeSessionId]);

  function renderComposer(options: {
    placement: "centered" | "docked";
    mode: ComposerMode;
  }) {
    const isCentered = options.placement === "centered";
    const isCreateSessionOnly = options.mode === "create-session-only";
    const isBootstrap = options.mode === "bootstrap";
    const composerDisabled = isCreateSessionOnly || activeSessionReadOnly;
    const canSubmitActiveMessage =
      !isCreateSessionOnly &&
      !composerDisabled &&
      !uploading &&
      (!loading || activeSessionReadOnly) &&
      (Boolean(text.trim()) || pendingAttachments.length > 0 || selectedSkills.length > 0);

    const shellClassName = isCentered
      ? "mx-auto flex w-full max-w-[min(46rem,100%)] flex-col justify-center py-8 sm:py-12"
      : "shrink-0 border-t border-[color:var(--border-subtle)] bg-[rgba(248,250,252,0.78)] px-2 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-2 sm:py-2";
    const contentClassName = isCentered
      ? "rounded-[1rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-3 py-3 shadow-[var(--shadow-panel)] sm:px-3 sm:py-3"
      : "mx-auto w-full max-w-none rounded-[1rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-3 py-2.5 shadow-[var(--shadow-soft)] sm:px-2 sm:py-2";

    return (
      <div
        ref={isCentered ? undefined : dockedComposerRef}
        className={shellClassName}
      >
        <div className={contentClassName}>
          {pendingAttachments.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {pendingAttachments.map((attachment) => (
                <AttachmentBadge
                  key={attachment.id}
                  attachment={attachment}
                  messages={messages}
                  tone="composer"
                  onRemove={handleRemovePendingAttachment}
                />
              ))}
            </div>
          ) : null}
          {selectedSkills.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {selectedSkills.map((skill) => (
                <SelectedSkillBadge
                  key={skill.key}
                  skill={skill}
                  messages={messages}
                  tone="composer"
                  onRemove={handleRemoveSelectedSkill}
                />
              ))}
            </div>
          ) : null}
          {skillsOpen && !isCreateSessionOnly ? (
            <>
              <button
                type="button"
                aria-label={messages.common.cancel}
                onClick={() => setSkillsOpen(false)}
                className="ui-overlay fixed inset-0 z-20 sm:hidden"
              />
              <div
                ref={mobileSkillsSheetRef}
                className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] z-30 sm:hidden"
              >
                <div className="rounded-[1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-3 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{messages.chat.skills}</p>
                    <button
                      type="button"
                      onClick={() => setSkillsOpen(false)}
                      className="ui-button-secondary ui-button-chip font-medium"
                    >
                      {messages.common.cancel}
                    </button>
                  </div>

                  {skillsLoading ? (
                    <p className="text-[11px] text-[color:var(--text-secondary)]">{messages.chat.skillsLoading}</p>
                  ) : null}

                  {!skillsLoading && skillsError ? (
                    <div className="rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-2.5 py-2">
                      <p className="text-[11px] leading-5 text-red-600">{skillsError}</p>
                      <button
                        type="button"
                        onClick={handleRetryLoadSkills}
                        className="ui-button-secondary ui-button-chip mt-2 font-medium"
                      >
                        {messages.chat.retryLoadSkills}
                      </button>
                    </div>
                  ) : null}

                  {!skillsLoading && !skillsError && sortedSkills.length === 0 ? (
                    <p className="text-[11px] text-[color:var(--text-secondary)]">{messages.chat.noSkills}</p>
                  ) : null}

                  {!skillsLoading && !skillsError && sortedSkills.length > 0 ? (
                    <div className="max-h-[min(18rem,42vh)] space-y-2 overflow-y-auto pr-0.5">
                      {sortedSkills.map((skill) => (
                        <SkillListItemCard
                          key={skill.key}
                          skill={skill}
                          messages={messages}
                          selected={selectedSkills.some((item) => item.key === skill.key)}
                          onToggle={handleToggleSkillSelection}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
          {showSlashSuggestions && !isCreateSessionOnly ? (
            <>
              <button
                type="button"
                aria-label={messages.common.cancel}
                onClick={() => setDismissedSlashPanelKey(activeSlashMatch?.dismissKey ?? null)}
                className="ui-overlay fixed inset-0 z-20 sm:hidden"
              />
              <div
                className="fixed inset-x-3 z-30 sm:hidden"
                style={{
                  bottom: `calc(env(safe-area-inset-bottom) + ${Math.max(5.25, Math.min(8.5, mobileSlashSheetMaxHeight / 52))}rem)`,
                }}
              >
                <div className="rounded-[1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-3 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{messages.chat.slashMenuTitle}</p>
                    <button
                      type="button"
                      onClick={() => setDismissedSlashPanelKey(activeSlashMatch?.dismissKey ?? null)}
                      className="ui-button-secondary ui-button-chip font-medium"
                    >
                      {messages.common.cancel}
                    </button>
                  </div>
                  <div className="overflow-y-auto pr-0.5" style={{ maxHeight: `${mobileSlashSheetMaxHeight}px` }}>
                    <SlashCommandList
                      suggestions={slashSuggestions}
                      highlightedIndex={highlightedSlashIndex}
                      query={activeSlashMatch?.query ?? ""}
                      messages={messages}
                      loadingSkills={skillsLoading}
                      skillsError={skillsError}
                      onSelect={handleSelectSlashSuggestion}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!isCreateSessionOnly) {
                void submitActiveMessage();
              }
            }}
            className="relative px-0.5 py-0.5"
          >
            {activeSessionReadOnly ? (
              <p className="ui-field-note mb-2 rounded-[0.9rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2.5 text-[color:var(--text-secondary)]">
                {messages.chat.archivedReadOnlyNotice}
              </p>
            ) : null}
            {showSlashSuggestions && !isCreateSessionOnly ? (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 hidden sm:block">
                <div className="rounded-[0.9rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-3 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">{messages.chat.slashMenuTitle}</p>
                    <p className="text-[10px] text-[color:var(--text-tertiary)]">{messages.chat.slashKeyboardHint}</p>
                  </div>
                  <div className="max-h-64 overflow-y-auto pr-0.5">
                    <SlashCommandList
                      suggestions={slashSuggestions}
                      highlightedIndex={highlightedSlashIndex}
                      query={activeSlashMatch?.query ?? ""}
                      messages={messages}
                      loadingSkills={skillsLoading}
                      skillsError={skillsError}
                      onSelect={handleSelectSlashSuggestion}
                    />
                  </div>
                </div>
              </div>
            ) : null}
            <textarea
              ref={composerTextareaRef}
              value={text}
              onChange={(event) => {
                if (isCreateSessionOnly) {
                  return;
                }
                const value = event.target.value;
                if (activeSessionId) {
                  setComposerBySession((current) => ({ ...current, [activeSessionId]: value }));
                } else if (isBootstrap) {
                  setBootstrapComposerText(value);
                  if (bootstrapError) {
                    setBootstrapError(null);
                  }
                }
                syncComposerSelectionFromElement(event.target);
              }}
              onSelect={(event) => {
                syncComposerSelectionFromElement(event.currentTarget);
              }}
              onClick={(event) => {
                syncComposerSelectionFromElement(event.currentTarget);
              }}
              onKeyUp={(event) => {
                syncComposerSelectionFromElement(event.currentTarget);
              }}
              onKeyDown={handleComposerKeyDown}
              rows={isCentered ? 3 : 2}
              placeholder={
                activeSessionReadOnly
                  ? messages.chat.archivedMessagePlaceholder
                  : `${messages.chat.messagePlaceholder} ${messages.chat.composerUsageHint}`
              }
              className={`w-full resize-none overflow-y-hidden bg-transparent px-0 py-0 text-[16px] leading-6 text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-quaternary)] sm:text-[14px] sm:leading-6 ${
                isCentered ? "min-h-[5.5rem] sm:min-h-[5rem]" : "min-h-[3.75rem] sm:min-h-[3.25rem]"
              } ${isCreateSessionOnly ? "cursor-default opacity-60" : ""}`}
              disabled={composerDisabled || loading}
            />
            {!showSlashSuggestions && showSlashHint && activeSlashCommand ? (
              <SlashCommandHint command={activeSlashCommand} messages={messages} />
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-[color:var(--border-subtle)] pt-2">
              <div className="min-w-0 flex flex-wrap items-center gap-1">
                <label className="ui-button-secondary ui-button-chip inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    disabled={composerDisabled || isBootstrap || uploading || loading}
                    onChange={(event) => {
                      void uploadFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  {uploading ? messages.chat.uploading : messages.chat.attach}
                </label>
                {lazycatFilePickerEnabled && lazycatFilePickerAvailable ? (
                  <button
                    type="button"
                    onClick={() => setLazycatPickerOpen(true)}
                    disabled={composerDisabled || isBootstrap || uploading || loading}
                    className="ui-button-secondary ui-button-chip inline-flex items-center gap-1.5"
                  >
                    {messages.chat.lazycatAttach}
                  </button>
                ) : null}
                <div ref={skillsPopoverRef} className="relative">
                  {skillsOpen && !isCreateSessionOnly ? (
                    <div className="absolute bottom-full left-0 z-20 mb-2 hidden sm:block sm:w-[min(40rem,calc(100vw-4rem))] sm:max-w-[calc(100vw-4rem)]">
                      <div className="relative rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-2.5 py-2 shadow-[var(--shadow-panel)] backdrop-blur">
                        <span
                          aria-hidden="true"
                          className="absolute bottom-[-0.35rem] left-5 size-3 rotate-45 border-r border-b border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)]"
                        />
                        <div className="relative flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-[color:var(--text-primary)]">{messages.chat.skills}</p>
                          <button
                            type="button"
                            onClick={() => setSkillsOpen(false)}
                            className="ui-button-secondary ui-button-chip font-medium"
                          >
                            {messages.common.cancel}
                          </button>
                        </div>

                        {skillsLoading ? (
                          <p className="mt-2 text-[11px] text-[color:var(--text-secondary)]">{messages.chat.skillsLoading}</p>
                        ) : null}

                        {!skillsLoading && skillsError ? (
                          <div className="mt-2 rounded-[0.7rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-2.5 py-2">
                            <p className="text-[11px] leading-5 text-red-600">{skillsError}</p>
                            <button
                              type="button"
                              onClick={handleRetryLoadSkills}
                              className="ui-button-secondary ui-button-chip mt-2 font-medium"
                            >
                              {messages.chat.retryLoadSkills}
                            </button>
                          </div>
                        ) : null}

                        {!skillsLoading && !skillsError && sortedSkills.length === 0 ? (
                          <p className="mt-2 text-[11px] text-[color:var(--text-secondary)]">{messages.chat.noSkills}</p>
                        ) : null}

                        {!skillsLoading && !skillsError && sortedSkills.length > 0 ? (
                          <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-0.5">
                            {sortedSkills.map((skill) => (
                              <SkillListItemCard
                                key={skill.key}
                                skill={skill}
                                messages={messages}
                                selected={selectedSkills.some((item) => item.key === skill.key)}
                                onToggle={handleToggleSkillSelection}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={handleToggleSkills}
                    disabled={composerDisabled || isBootstrap || uploading || loading}
                    className="ui-button-secondary ui-button-chip disabled:cursor-not-allowed"
                  >
                    {messages.chat.skills}
                  </button>
                </div>
                {!isCreateSessionOnly && !isBootstrap && !activeSessionReadOnly ? (
                  <ComposerContextUsage
                    usage={contextUsage}
                    loading={contextLoading}
                    messages={messages}
                  />
                ) : null}
              </div>
              {isCreateSessionOnly ? (
                <button
                  type="button"
                  onClick={handleCreateSessionClick}
                  className="ui-button-primary ui-button-chip shrink-0 font-semibold"
                >
                  {messages.nav.newSession}
                </button>
              ) : isBootstrap && !text.trim() ? (
                <button
                  type="button"
                  disabled
                  className="ui-button-secondary ui-button-chip shrink-0 font-semibold opacity-70 disabled:cursor-not-allowed"
                >
                  {bootstrapPending ? messages.common.loading : messages.nav.newSession}
                </button>
              ) : activeSessionReadOnly ? (
                <button
                  type="button"
                  disabled
                  className="ui-button-secondary ui-button-chip shrink-0 font-semibold opacity-70 disabled:cursor-not-allowed"
                >
                  {messages.chat.readOnly}
                </button>
              ) : loading ? (
                <button
                  type="button"
                  onClick={() => {
                    void abortSession();
                  }}
                  className="ui-button-danger ui-icon-button shrink-0"
                  aria-label={messages.chat.abort}
                  title={messages.chat.abort}
                >
                  <StopSquareIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSubmitActiveMessage}
                  className="ui-button-primary ui-button-chip shrink-0 font-semibold disabled:cursor-not-allowed"
                >
                  {messages.chat.send}
                </button>
              )}
            </div>
          </form>
          {!isCreateSessionOnly && (error || bootstrapError) ? (
            <div className="mt-1.5 text-[11px] text-red-600">
              <p>{error?.message ?? bootstrapError}</p>
              <ErrorDiagnosticDetails messages={messages} diagnostic={error?.diagnostic ?? null} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative grid h-full min-h-0 gap-1.5 lg:grid-cols-[auto_minmax(0,1fr)]">
      {drawerOpen ? (
        <button
          type="button"
          aria-label={messages.nav.closeDrawer}
          onClick={() => setDrawerOpen(false)}
          className="ui-overlay fixed inset-0 z-20 lg:hidden"
        />
      ) : null}

      <ChatSidebar
        locale={locale}
        messages={messages}
        drawerOpen={drawerOpen}
        isSidebarCollapsed={isSidebarCollapsed}
        user={user}
        recentSessions={recentSidebarSessions}
        archivedSessions={archivedSidebarSessions}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        sessionsScrollerRef={sessionsScrollerRef}
        loadMoreSentinelRef={loadMoreSentinelRef}
        onCloseDrawer={handleCloseDrawer}
        onCollapseSidebar={handleCollapseSidebar}
        onExpandSidebar={handleExpandSidebar}
        onCreateSession={handleCreateSessionClick}
        onSelectSession={handleSelectSession}
        onOpenRenameModal={openRenameModal}
        onLoadMoreSessions={handleLoadMoreSessions}
      />

      <section
        aria-label={t(messages.nav.chatWorkspace, { agentId: user.openclawAgentId })}
        className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[0.9rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.74)] shadow-[var(--shadow-panel)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2.5 sm:px-2 sm:py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={handleOpenDrawer}
              className="ui-button-secondary ui-icon-button !inline-flex shrink-0 [&>svg]:block [&>svg]:-translate-y-px lg:!hidden"
              aria-label={messages.nav.openDrawer}
              title={messages.nav.openDrawer}
            >
              <ChatBubbleIcon />
            </button>
            <h2 className="truncate text-sm font-semibold text-[color:var(--text-primary)]">
              {activeSession?.title ?? messages.nav.createSession}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {activeSession ? (
              <button
                type="button"
                onClick={() => {
                  void openShareModal(activeSession);
                }}
                className="ui-button-secondary ui-button-chip inline-flex items-center gap-1 font-medium"
                aria-label={messages.chat.shareSession}
                title={messages.chat.shareSession}
              >
                <ShareIcon />
                <span>{messages.chat.shareOpen}</span>
              </button>
            ) : null}
            <LanguageSwitcher locale={locale} messages={messages} />
          </div>
        </div>

        <div
          ref={messagesScrollerRef}
          onScroll={handleMessagesScroll}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-2 sm:py-2"
        >
          <div key={activeSessionId ?? "no-session"} className="mx-auto flex min-h-full w-full max-w-none flex-col gap-2">
            {pairing ? (
              <div className="max-w-[96ch] rounded-[0.95rem] border border-[color:var(--border-strong)] bg-[color:var(--surface-subtle)] px-3 py-3 text-[color:var(--text-primary)] sm:px-4 sm:py-3">
                <p className="text-sm font-semibold">{messages.chat.pairingTitle}</p>
                <p className="ui-field-note mt-1.5 text-[color:var(--text-secondary)]">
                  {messages.chat.pairingDescription}
                </p>
              </div>
            ) : null}

            {deviceAuthorizationExpired && !pairing ? (
              <div className="max-w-[96ch] rounded-[0.95rem] border border-[color:var(--border-strong)] bg-[color:var(--surface-subtle)] px-3 py-3 text-[color:var(--text-primary)] sm:px-4 sm:py-3">
                <p className="text-sm font-semibold">{messages.chat.deviceAuthorizationExpiredTitle}</p>
                <p className="ui-field-note mt-1.5 text-[color:var(--text-secondary)]">
                  {messages.chat.deviceAuthorizationExpiredDescription}
                </p>
                {user.role === "ADMIN" ? (
                  <Link
                    href={workspaceSettingsHref}
                    className="ui-button-secondary ui-button-chip mt-3 inline-flex font-medium"
                  >
                    {messages.chat.deviceAuthorizationExpiredAdminAction}
                  </Link>
                ) : (
                  <p className="mt-3 text-sm text-[color:var(--text-secondary)]">
                    {messages.chat.deviceAuthorizationExpiredMemberAction}
                  </p>
                )}
              </div>
            ) : null}

            {shouldCenterEmptyState ? (
              <div className="flex min-h-full flex-1 items-center">
                {renderComposer({
                  placement: "centered",
                  mode: composerMode,
                })}
              </div>
            ) : null}

            {renderableMessages.map((item) => (
              <ChatMessageItem
                key={item.id}
                item={item}
                locale={locale}
                messages={messages}
                segmentation={item.run ? contentSegmentsByRunId[item.run.runId] ?? null : null}
              />
            ))}

            {activeRun && isActiveSessionRunStatus(activeRun.status) ? (
              <ActiveRunPanel
                key={visibleDraftKey}
                activeRun={activeRun}
                activeRunBlocks={activeRunBlocks}
                locale={locale}
                messages={messages}
              />
            ) : null}
            <div ref={messagesBottomSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />
          </div>
        </div>

        <div
          aria-hidden={!showScrollToBottom}
          style={{ bottom: `${Math.max(16, Math.round(dockedComposerHeight + 16))}px` }}
          className={`absolute inset-x-0 z-10 flex justify-center px-3 transition-[opacity,transform] duration-200 ${
            showScrollToBottom ? "pointer-events-none opacity-100 translate-y-0" : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            tabIndex={showScrollToBottom ? 0 : -1}
            className={`ui-button-primary ui-button-chip inline-flex items-center gap-2 font-medium shadow-[var(--shadow-float)] transition-[opacity,transform] duration-200 ${
              showScrollToBottom ? "pointer-events-auto" : "pointer-events-none"
            }`}
          >
            <span aria-hidden="true" className="text-xs leading-none">↓</span>
            <span>{loading ? messages.chat.newMessages : messages.chat.backToBottom}</span>
          </button>
        </div>

        {!shouldCenterEmptyState
          ? renderComposer({
              placement: "docked",
              mode: isEmptyState ? composerMode : "active-session",
            })
          : null}
      </section>

      {renameTargetSession ? (
        <div className="ui-overlay fixed inset-0 z-40 flex items-end justify-center px-4 py-4 sm:items-center">
          <button
            type="button"
            aria-label={messages.nav.closeRenameModal}
            onClick={closeRenameModal}
            className="absolute inset-0"
          />
          <div className="ui-card ui-dialog relative z-10 w-full max-w-md">
            <div className="mb-4">
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">{messages.chat.renameSession}</p>
              <p className="ui-field-note mt-1">{messages.chat.renameDescription}</p>
            </div>

            <form onSubmit={submitRenameSession}>
              <label className="block">
                <span className="sr-only">{messages.chat.sessionTitle}</span>
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameTitle}
                  maxLength={SESSION_TITLE_MAX_LENGTH}
                  disabled={renameSubmitting}
                  onChange={(event) => {
                    setRenameTitle(event.target.value);
                    if (renameError) {
                      setRenameError(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeRenameModal();
                    }
                  }}
                  className="ui-input"
                  placeholder={messages.chat.sessionTitlePlaceholder}
                />
              </label>

              {renameError ? <p className="ui-field-note mt-2 text-red-600">{renameError}</p> : null}

              <div className="ui-dialog-actions mt-4">
                <button
                  type="button"
                  onClick={closeRenameModal}
                  disabled={renameSubmitting}
                  className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
                >
                  {messages.common.cancel}
                </button>
                <button
                  type="submit"
                  disabled={renameSubmitting}
                  className="ui-button-primary ui-button-chip font-semibold disabled:cursor-not-allowed"
                >
                  {renameSubmitting ? messages.common.saving : messages.common.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {shareTargetSession ? (
        <div className="ui-overlay fixed inset-0 z-40 flex items-end justify-center px-4 py-4 sm:items-center">
          <button
            type="button"
            aria-label={messages.chat.shareSession}
            onClick={closeShareModal}
            className="absolute inset-0"
          />
          <div className="ui-card ui-dialog relative z-10 w-full max-w-md">
            <div className="mb-4">
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">{messages.chat.shareSession}</p>
              <p className="ui-field-note mt-1">{messages.chat.shareDescription}</p>
            </div>

            {shareLoading ? (
              <p className="text-sm text-[color:var(--text-secondary)]">{messages.chat.shareLoading}</p>
            ) : (
              <form onSubmit={submitShareSession}>
                <div className="space-y-2">
                  <label className="flex min-h-[var(--touch-target-min)] items-start gap-2 rounded-[0.95rem] border border-[color:var(--border-subtle)] px-3 py-3">
                    <input
                      type="radio"
                      name="share-access-mode"
                      checked={shareAccessMode === "PUBLIC"}
                      onChange={() => setShareAccessMode("PUBLIC")}
                    />
                    <span className="text-sm text-[color:var(--text-primary)]">{messages.chat.sharePublicOption}</span>
                  </label>
                  <label className="flex min-h-[var(--touch-target-min)] items-start gap-2 rounded-[0.95rem] border border-[color:var(--border-subtle)] px-3 py-3">
                    <input
                      type="radio"
                      name="share-access-mode"
                      checked={shareAccessMode === "PASSWORD"}
                      onChange={() => setShareAccessMode("PASSWORD")}
                    />
                    <div>
                      <p className="text-sm text-[color:var(--text-primary)]">{messages.chat.sharePasswordOption}</p>
                      <p className="ui-field-note mt-1">{messages.chat.sharePasswordHint}</p>
                    </div>
                  </label>
                </div>

                {shareAccessMode === "PASSWORD" ? (
                  <div className="mt-3">
                    <input
                      ref={sharePasswordInputRef}
                      type="password"
                      value={sharePassword}
                      onChange={(event) => {
                        setSharePassword(event.target.value);
                        if (shareError) {
                          setShareError(null);
                        }
                      }}
                      disabled={shareSubmitting}
                      className="ui-input"
                      placeholder={messages.chat.sharePasswordPlaceholder}
                    />
                  </div>
                ) : null}

                <div className="mt-4 rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2">
                  <p className="text-sm font-medium text-[color:var(--text-primary)]">
                    {shareState?.enabled ? messages.chat.shareEnabled : messages.chat.shareDisabled}
                  </p>
                  {shareState?.shareUrl ? (
                    <div className="mt-2 flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm text-[color:var(--text-tertiary)]">{shareCopyUrl}</p>
                      <CopyButton
                        text={shareCopyUrl}
                        successLabel={messages.chat.copied}
                        ariaLabel={messages.chat.shareCopyLink}
                        iconClassName={COPY_ICON_CLASS_NAME}
                        iconButtonClassName={COPY_ICON_BUTTON_CLASS_NAME}
                      />
                    </div>
                  ) : null}
                  {shareState?.snapshotUpdatedAt ? (
                    <p className="mt-2 text-[11px] text-[color:var(--text-tertiary)]">
                      {messages.chat.shareSnapshotUpdated}: {formatRelativeDate(shareState.snapshotUpdatedAt, locale, messages.common.noActivityYet)}
                    </p>
                  ) : null}
                </div>

                {shareError ? <p className="ui-field-note mt-2 text-red-600">{shareError}</p> : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={closeShareModal}
                    disabled={shareSubmitting}
                    className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
                  >
                    {messages.common.cancel}
                  </button>
                  <div className="flex items-center gap-2">
                    {shareState?.enabled ? (
                      <button
                        type="button"
                        onClick={() => {
                          void stopSharingSession();
                        }}
                        disabled={shareSubmitting}
                        className="ui-button-secondary ui-button-chip font-medium disabled:cursor-not-allowed"
                      >
                        {messages.chat.shareStop}
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      disabled={shareSubmitting}
                      className="ui-button-primary ui-button-chip font-semibold disabled:cursor-not-allowed"
                    >
                      {shareSubmitting ? messages.common.saving : messages.chat.shareUpdate}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {lazycatFilePickerEnabled ? (
        <LazycatFilePickerBridge
          messages={messages}
          open={lazycatPickerOpen}
          onClose={() => setLazycatPickerOpen(false)}
          onSubmit={handleLazycatSubmit}
          onAvailabilityChange={handleLazycatAvailabilityChange}
          onError={handleLazycatError}
        />
      ) : null}
    </div>
  );
}
