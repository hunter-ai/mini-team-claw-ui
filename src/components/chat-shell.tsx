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
import { LanguageSwitcher } from "@/components/language-switcher";
import { formatRelativeDate } from "@/lib/utils";
import { LOCALE_HEADER_NAME, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getLifecycleTitle, t } from "@/lib/i18n/messages";
import { localizeHref } from "@/lib/i18n/routing";
import { LogoutButton } from "@/components/logout-button";
import type { SessionContextUsage } from "@/lib/session-context-usage";

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

type Session = {
  id: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
  lastMessageAt: string | null;
  activeRun: SessionRun | null;
};

type PairingState = {
  status: "pairing_required";
  message: string;
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

type RunState = "idle" | "starting" | "streaming" | "reconnecting" | "failed" | "aborted" | "completed";
type StreamPayload = ClientChatRunEvent | { type: "ping"; runId: string; seq: null };
type BufferedRunPatch = {
  runId: string;
  draftAssistantContent: string;
  lastEventSeq: number;
  updatedAt: string;
};

type SessionContextUsageState = {
  status: "ok" | "unavailable";
  usage: SessionContextUsage | null;
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
    };
  }

  return null;
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
      <MessageBody content={content} isUser={false} assistantRenderMode={renderMode} />
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
    </div>
  );
}

function AttachmentBadge({
  attachment,
  messages,
  tone = "composer",
}: {
  attachment: Attachment;
  messages: Dictionary;
  tone?: "composer" | "user-message" | "assistant-message";
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

  return (
    <span
      className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-[0.9rem] border px-2.5 py-1.5 text-[10px] leading-tight sm:px-3 sm:text-[11px] ${styles.outer}`}
    >
      <span className="max-w-full truncate font-semibold">{attachment.originalName}</span>
      <span className={`text-[0.92em] ${styles.meta}`}>
        {attachment.mime || messages.chat.unknown} · {formatFileSize(attachment.size)}
      </span>
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

function MessageBody({
  content,
  isUser,
  assistantRenderMode = "markdown",
}: {
  content: string;
  isUser: boolean;
  assistantRenderMode?: ClientAssistantRenderMode;
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
    <div className="markdown-body text-sm leading-7">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
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
  return <span aria-hidden="true" className="text-sm leading-none">{collapsed ? "»" : "«"}</span>;
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

function GaugeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="size-4">
      <path
        d="M3.75 13.75a6.25 6.25 0 1 1 12.5 0"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
      <path
        d="M10 10l3-2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
      <circle cx="10" cy="10" r="1.125" fill="currentColor" />
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

function ComposerContextUsage({
  usage,
  loading,
}: {
  usage: SessionContextUsage | null;
  loading: boolean;
}) {
  if (!usage && !loading) {
    return null;
  }

  const usageRatio = usage?.usageRatio ?? 0;
  const toneClassName =
    usage && usageRatio >= 1
      ? "text-red-600"
      : usage && usageRatio >= 0.85
        ? "text-amber-600"
        : "text-[color:var(--text-secondary)]";
  const trackClassName =
    usage && usageRatio >= 1
      ? "bg-red-500"
      : usage && usageRatio >= 0.85
        ? "bg-amber-500"
        : "bg-[color:var(--text-primary)]";

  return (
    <div className={`mt-1.5 inline-flex max-w-full items-center gap-2 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-2 py-1 text-[10px] sm:text-[11px] ${toneClassName}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">
          <GaugeIcon />
        </span>
        <span className="truncate font-medium">
          {loading && !usage ? "..." : `${formatCompactTokenCount(usage?.usedTokens ?? 0)}/${formatCompactTokenCount(usage?.totalTokens ?? 0)}`}
        </span>
      </div>
      <div className="h-1.5 min-w-14 flex-1 overflow-hidden rounded-full bg-[rgba(15,23,42,0.08)] sm:min-w-16">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${trackClassName} ${loading && !usage ? "animate-pulse opacity-50" : ""}`}
          style={{ width: `${Math.max(8, Math.round((usage?.usageRatio ?? 0.18) * 100))}%` }}
        />
      </div>
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
    <div
      className={`rounded-[0.8rem] border px-2 py-1.75 sm:px-3 sm:py-2 ${
        isUser
          ? "ml-auto w-fit max-w-[min(100%,44rem)] border-[rgba(17,24,39,0.18)] bg-[#d1d5db] text-[color:var(--text-primary)] shadow-[0_8px_20px_rgba(15,23,42,0.08)]"
          : "w-full max-w-[min(124ch,100%)] border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)] text-[color:var(--text-primary)]"
      }`}
    >
      <div>
        {isUser ? (
          <MessageBody content={content} isUser />
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
    <div className="w-full max-w-[min(124ch,100%)] rounded-[0.8rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)] px-2 py-1.75 text-[color:var(--text-primary)] sm:px-3 sm:py-2">
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
      <p className="mt-1 text-[10px] text-[color:var(--text-quaternary)]">{formatRelativeDate(activeRun.updatedAt, locale, messages.common.noActivityYet)}</p>
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
  const GROUP_PAGE_SIZE = 8;
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
        className={`w-full rounded-[0.75rem] border text-left transition ${
          collapsed ? "px-1.5 py-2 lg:min-h-10" : "px-2 py-2"
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
            <p className="truncate text-xs font-medium text-[color:var(--text-primary)]">{session.title}</p>
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
      className="flex w-full items-center justify-between rounded-[0.65rem] px-1 py-1 text-left transition hover:bg-[color:var(--surface-subtle)]"
      aria-expanded={expanded}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--text-quaternary)]">
        {title}
      </span>
      <span className="flex items-center gap-1 text-[10px] text-[color:var(--text-quaternary)]">
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
      className={`fixed inset-y-1.5 left-1.5 z-30 flex w-[calc(100vw-0.75rem)] max-w-[20rem] shrink-0 flex-col overflow-hidden rounded-[1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.96)] shadow-[var(--shadow-panel)] transition-[width,transform] duration-300 lg:static lg:inset-auto lg:z-auto lg:h-full lg:max-w-none lg:rounded-[0.9rem] ${
        drawerOpen ? "translate-x-0" : "-translate-x-[108%] lg:translate-x-0"
      } ${isSidebarCollapsed ? "lg:w-[3.5rem]" : "lg:w-[14.5rem] xl:w-[15.25rem]"}`}
    >
      <div className="border-b border-[color:var(--border-subtle)] px-2 py-1.5 sm:px-2.5">
        {isSidebarCollapsed ? (
          <div className="hidden justify-center lg:flex">
            <button
              type="button"
              onClick={onExpandSidebar}
              className="ui-button-secondary inline-flex size-8 shrink-0 items-center justify-center rounded-full p-0 text-xs [&>span]:block [&>span]:-translate-y-px"
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
                <p className="truncate text-[11px] font-medium text-[color:var(--text-primary)]">{user.openclawAgentId}</p>
                <p className="mt-0.5 truncate text-[10px] text-[color:var(--text-quaternary)]">{user.username}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCollapseSidebar}
                  className="ui-button-secondary hidden size-8 shrink-0 items-center justify-center rounded-full p-0 text-xs [&>span]:block [&>span]:-translate-y-px lg:inline-flex"
                  aria-label={messages.nav.collapseSidebar}
                  title={messages.nav.collapseSidebar}
                >
                  <SidebarToggleIcon collapsed={false} />
                </button>
                <button
                  type="button"
                  onClick={onCloseDrawer}
                  className="ui-button-secondary inline-flex size-8 items-center justify-center rounded-full lg:hidden"
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
                className="ui-button-primary min-w-0 flex-1 rounded-[0.7rem] px-2.5 py-1.5 text-[11px] font-semibold"
              >
                {messages.nav.new}
              </button>
            </div>
          </>
        )}
      </div>

      <div
        ref={sessionsScrollerRef}
        className={`min-h-0 flex-1 overflow-y-auto py-1.5 ${isSidebarCollapsed ? "px-1" : "px-1.5"}`}
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
            <div className="px-1 py-1 text-center text-[10px] text-[color:var(--text-quaternary)]">
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
        <div className="border-t border-[color:var(--border-subtle)] px-2 py-1.5 sm:px-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            {user.role === "ADMIN" ? (
              <Link
                href={localizeHref(locale, "/admin")}
                className="ui-button-secondary inline-flex h-8 items-center justify-center rounded-[0.7rem] px-2.5 text-[11px] font-medium"
              >
                {messages.nav.admin}
              </Link>
            ) : (
              <span className="hidden" aria-hidden="true" />
            )}
            <LogoutButton
              locale={locale}
              messages={messages}
              className={`ui-button-secondary inline-flex h-8 items-center justify-center rounded-[0.7rem] px-2.5 text-[11px] font-medium ${
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
  user: UserShape;
}) {
  const pageSize = 30;
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
  const [errorBySession, setErrorBySession] = useState<Record<string, string | null>>({});
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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsFetched, setSkillsFetched] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionsScrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollerRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const shouldSnapMessagesToBottomRef = useRef(true);
  const shouldStickMessagesToBottomRef = useRef(false);
  const isProgrammaticMessagesScrollRef = useRef(false);
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
  const loadSessionRef = useRef<(sessionId: string, clearError?: boolean) => Promise<void>>(async () => {});

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const renameTargetSession = useMemo(
    () => sessions.find((session) => session.id === renameSessionId) ?? null,
    [renameSessionId, sessions],
  );
  const sessionMessages = useMemo(
    () => (activeSessionId ? messagesBySession[activeSessionId] ?? [] : []),
    [activeSessionId, messagesBySession],
  );
  const runHistory = useMemo(
    () => (activeSessionId ? runHistoryBySession[activeSessionId] ?? [] : []),
    [activeSessionId, runHistoryBySession],
  );
  const text = activeSessionId ? composerBySession[activeSessionId] ?? "" : "";
  const pendingAttachments = activeSessionId ? pendingAttachmentsBySession[activeSessionId] ?? [] : [];
  const selectedSkills = activeSessionId ? selectedSkillsBySession[activeSessionId] ?? [] : [];
  const activeRun = activeSessionId ? activeRunBySession[activeSessionId] ?? null : null;
  const loading = activeSessionId ? isRunBusy(runStateBySession[activeSessionId] ?? "idle") : false;
  const uploading = activeSessionId ? uploadingBySession[activeSessionId] ?? false : false;
  const error = activeSessionId ? errorBySession[activeSessionId] ?? null : null;
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
  const sortedSkills = useMemo(
    () =>
      skills
        .filter((skill) => skill.eligible && !skill.disabled && !skill.blockedByAllowlist)
        .sort(compareSkills),
    [skills],
  );
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
  const isCenteredEmptyState =
    (!activeSessionId || activeSessionLoaded) &&
    !pairing &&
    !activeRun &&
    sessionMessages.length === 0 &&
    !activeSessionReadOnly;

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

    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  }, []);

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
          status?: "ok" | "busy" | "unavailable";
          usage?: SessionContextUsage;
        };

        if (contextRequestVersionBySessionRef.current[sessionId] !== requestVersion) {
          return;
        }

        if (!response.ok || payload.status === "unavailable") {
          setContextUsageBySession((current) => ({
            ...current,
            [sessionId]: {
              status: "unavailable",
              usage: current[sessionId]?.usage ?? null,
            },
          }));
          return;
        }

        if (payload.status === "busy") {
          return;
        }

        if (payload.status === "ok" && payload.usage) {
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
      } else if (payload.type === "aborted") {
        setSessionRunState(sessionId, "aborted");
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.reason }));
      } else if (payload.type === "pairing_required") {
        setSessionRunState(sessionId, "failed");
        setPairingBySession((current) => ({ ...current, [sessionId]: payload.pairing }));
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.pairing.message }));
      } else {
        setSessionRunState(sessionId, "failed");
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.error }));
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
      void loadSessionRef.current(sessionId, false);
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
          [sessionId]: messages.chat.connectionLost,
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
    }

    const response = await localeFetch(`/api/sessions/${sessionId}/messages`, {
      cache: "no-store",
    });

    if (!response.ok) {
      setErrorBySession((current) => ({ ...current, [sessionId]: messages.chat.failedToLoadSession }));
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
      if (payload.session.status !== "ARCHIVED") {
        void refreshSessionContext(sessionId);
      }
      return;
    }

    lastEventSeqByRunRef.current[nextActiveRun.id] = nextActiveRun.lastEventSeq;

    subscribeToRun(sessionId, nextActiveRun);
  }, [localeFetch, messages.chat.failedToLoadSession, refreshSessionContext, replaceRunHistory, setSessionRunState, subscribeToRun, updateActiveRun, updateSessionSummary]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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

  useEffect(() => {
    if (!skillsOpen) {
      return;
    }

    if (!skillsFetched) {
      void loadSkills();
    }
  }, [loadSkills, skillsFetched, skillsOpen]);

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

    void refreshSessionContext(initialActiveSessionId);
  }, [
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

    if (contextUsageBySession[activeSessionId]?.usage) {
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
    if (selectedSession?.status !== "ARCHIVED") {
      void refreshSessionContext(sessionId);
    }
  }, [activeSessionId, flushBufferedRunPatch, loadedSessionIds, loadSession, refreshSessionContext, sessions, subscribeToRun, syncSessionUrl]);

  const createSession = useCallback(async () => {
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
        setErrorBySession((current) => ({ ...current, [activeSessionId]: messages.chat.failedToCreateSession }));
      }
      return;
    }

    const payload = (await response.json()) as { session: Session };
    logChatShellDebug("[chat-debug][chat-shell] created session", {
      previousActiveSessionId: activeSessionId,
      newSessionId: payload.session.id,
    });
    updateSessionSummary(payload.session);
    setActiveSessionId(payload.session.id);
    setMessagesBySession((current) => ({ ...current, [payload.session.id]: [] }));
    setRunHistoryBySession((current) => ({ ...current, [payload.session.id]: [] }));
    setLoadedSessionIds((current) => ({ ...current, [payload.session.id]: true }));
    updateActiveRun(payload.session.id, null);
    setSessionRunState(payload.session.id, "idle");
    setPendingAttachmentsBySession((current) => ({ ...current, [payload.session.id]: [] }));
    setSelectedSkillsBySession((current) => ({ ...current, [payload.session.id]: [] }));
    setComposerBySession((current) => ({ ...current, [payload.session.id]: "" }));
    setPairingBySession((current) => ({ ...current, [payload.session.id]: null }));
    setShowScrollToBottom(false);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
    syncSessionUrl(payload.session.id);
  }, [activeSessionId, localeFetch, messages.chat.failedToCreateSession, syncSessionUrl, updateActiveRun, updateSessionSummary, setDrawerOpen, setSessionRunState]);

  const openRenameModal = useCallback((session: Session) => {
    if (isSidebarCollapsed || session.status === "ARCHIVED") {
      return;
    }

    setRenameSessionId(session.id);
    setRenameTitle(session.title);
    setRenameError(null);
    setRenameSubmitting(false);
  }, [isSidebarCollapsed]);

  const closeRenameModal = useCallback(() => {
    if (renameSubmitting) {
      return;
    }

    setRenameSessionId(null);
    setRenameTitle("");
    setRenameError(null);
  }, [renameSubmitting]);

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
    }).catch((fetchError) => fetchError);

    if (response instanceof Error) {
      setRenameError(response.message);
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
          errorMessage = rawText;
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

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !activeSessionId || activeSessionReadOnly) {
      return;
    }

    setUploadingBySession((current) => ({ ...current, [activeSessionId]: true }));
    setErrorBySession((current) => ({ ...current, [activeSessionId]: null }));
    const nextAttachments: Attachment[] = [];

    for (const file of Array.from(files)) {
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
          [activeSessionId]: payload.error ?? t(messages.chat.uploadFailedForFile, { fileName: file.name }),
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

  async function submitActiveMessage() {
    if (!activeSessionId || loading || activeSessionReadOnly) {
      return;
    }

    const currentText = composerBySession[activeSessionId] ?? "";
    const trimmedText = currentText.trim();
    const selectedAttachments = pendingAttachmentsBySession[activeSessionId] ?? [];
    const selectedSkillSnapshots = selectedSkillsBySession[activeSessionId] ?? [];

    if (!trimmedText && selectedAttachments.length === 0 && selectedSkillSnapshots.length === 0) {
      return;
    }

    const inputText = trimmedText ? currentText : "";
    const attachmentIds = selectedAttachments.map((attachment) => attachment.id);
    const skillKeys = selectedSkillSnapshots.map((skill) => skill.key);
    const clientRequestId = uuidv4();
    const targetSessionId = activeSessionId;
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
    }).catch((fetchError) => fetchError);

    if (response instanceof Error) {
      logChatShellDebug("[chat-debug][chat-shell] send failed before response", {
        sessionId: targetSessionId,
        clientRequestId,
        error: response.message,
      });
      setSessionRunState(targetSessionId, "failed");
      setErrorBySession((current) => ({ ...current, [targetSessionId]: response.message }));
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
          errorMessage = rawText;
        }
      }

      logChatShellDebug("[chat-debug][chat-shell] send failed with response", {
        sessionId: targetSessionId,
        clientRequestId,
        errorMessage,
        status: response.status,
      });
      setSessionRunState(targetSessionId, "failed");
      setErrorBySession((current) => ({ ...current, [targetSessionId]: errorMessage }));
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

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
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
    if (isProgrammaticMessagesScrollRef.current || !loading) {
      return;
    }

    if (!isNearMessagesBottom()) {
      shouldStickMessagesToBottomRef.current = false;
      setShowScrollToBottom(true);
      return;
    }

    shouldStickMessagesToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [isNearMessagesBottom, loading]);

  const handleScrollToBottomClick = useCallback(() => {
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = loading;
    setShowScrollToBottom(false);
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

    setSkillsOpen((current) => !current);
  }, [activeSessionId, activeSessionReadOnly, loading, uploading]);

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

  function renderComposer(options: {
    placement: "centered" | "docked";
    mode: "active-session" | "create-session-only";
  }) {
    const isCentered = options.placement === "centered";
    const isCreateSessionOnly = options.mode === "create-session-only";
    const composerDisabled = isCreateSessionOnly || !activeSessionId || activeSessionReadOnly;
    const canSubmitActiveMessage =
      !composerDisabled &&
      !uploading &&
      (!loading || activeSessionReadOnly) &&
      (Boolean(text.trim()) || pendingAttachments.length > 0 || selectedSkills.length > 0);

    const shellClassName = isCentered
      ? "mx-auto flex w-full max-w-[min(46rem,100%)] flex-col justify-center py-8 sm:py-12"
      : "shrink-0 border-t border-[color:var(--border-subtle)] bg-[rgba(248,250,252,0.78)] px-1 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:px-2 sm:py-2";
    const contentClassName = isCentered
      ? "rounded-[1rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-2 py-2 shadow-[var(--shadow-panel)] sm:px-3 sm:py-3"
      : "mx-auto w-full max-w-none rounded-[0.85rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-1.5 py-1.5 shadow-[var(--shadow-soft)] sm:px-2 sm:py-2";

    return (
      <div className={shellClassName}>
        <div className={contentClassName}>
          {pendingAttachments.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {pendingAttachments.map((attachment) => (
                <AttachmentBadge key={attachment.id} attachment={attachment} messages={messages} tone="composer" />
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
              <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] z-30 sm:hidden">
                <div className="rounded-[1rem] border border-[color:var(--border-subtle)] bg-[rgba(255,255,255,0.98)] px-3 py-3 shadow-[var(--shadow-panel)] backdrop-blur">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[color:var(--text-primary)]">{messages.chat.skills}</p>
                    <button
                      type="button"
                      onClick={() => setSkillsOpen(false)}
                      className="ui-button-secondary rounded-full px-2.5 py-1 text-[10px]"
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
                        className="ui-button-secondary mt-2 rounded-full px-2.5 py-1 text-[10px]"
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!isCreateSessionOnly) {
                void submitActiveMessage();
              }
            }}
            className="px-0.5 py-0.5"
          >
            {activeSessionReadOnly ? (
              <p className="mb-2 rounded-[0.7rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-2.5 py-2 text-[11px] text-[color:var(--text-secondary)] sm:text-xs">
                {messages.chat.archivedReadOnlyNotice}
              </p>
            ) : null}
            <textarea
              ref={composerTextareaRef}
              value={text}
              onChange={(event) => {
                if (!activeSessionId || isCreateSessionOnly) {
                  return;
                }
                const value = event.target.value;
                setComposerBySession((current) => ({ ...current, [activeSessionId]: value }));
              }}
              onKeyDown={handleComposerKeyDown}
              rows={isCentered ? 3 : 2}
              placeholder={
                activeSessionReadOnly
                  ? messages.chat.archivedMessagePlaceholder
                  : messages.chat.messagePlaceholder
              }
              className={`w-full resize-none overflow-y-hidden bg-transparent px-0 py-0 text-[15px] leading-5 text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-quaternary)] sm:text-sm sm:leading-6 ${
                isCentered ? "min-h-[4.5rem] sm:min-h-[5rem]" : "min-h-[3rem] sm:min-h-[3.25rem]"
              } ${isCreateSessionOnly ? "cursor-default opacity-60" : ""}`}
              disabled={composerDisabled || loading}
            />
            <div className="mt-1.5 flex items-center justify-between gap-1.5 border-t border-[color:var(--border-subtle)] pt-1.5">
              <div className="min-w-0 flex flex-wrap items-center gap-1">
                <label className="ui-button-secondary inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 text-[10px] sm:px-2.5 sm:text-[11px]">
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    disabled={composerDisabled || uploading || loading}
                    onChange={(event) => {
                      void uploadFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  {uploading ? messages.chat.uploading : messages.chat.attach}
                </label>
                <div className="relative">
                  {skillsOpen && !isCreateSessionOnly ? (
                    <div className="absolute bottom-full left-0 z-20 mb-2 hidden sm:block sm:w-[min(24rem,33vw)]">
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
                            className="ui-button-secondary rounded-full px-2 py-1 text-[10px]"
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
                              className="ui-button-secondary mt-2 rounded-full px-2.5 py-1 text-[10px]"
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
                    disabled={composerDisabled || uploading || loading}
                    className="ui-button-secondary rounded-full px-2 py-1 text-[10px] disabled:cursor-not-allowed sm:px-2.5 sm:text-[11px]"
                  >
                    {messages.chat.skills}
                  </button>
                </div>
              </div>
              {isCreateSessionOnly ? (
                <button
                  type="button"
                  onClick={handleCreateSessionClick}
                  className="ui-button-primary shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold sm:px-3 sm:py-1.5 sm:text-[11px]"
                >
                  {messages.nav.newSession}
                </button>
              ) : activeSessionReadOnly ? (
                <button
                  type="button"
                  disabled
                  className="ui-button-secondary shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold opacity-70 disabled:cursor-not-allowed sm:px-3 sm:py-1.5 sm:text-[11px]"
                >
                  {messages.chat.readOnly}
                </button>
              ) : loading ? (
                <button
                  type="button"
                  onClick={() => {
                    void abortSession();
                  }}
                  className="ui-button-danger inline-flex size-8 shrink-0 items-center justify-center rounded-full sm:size-9"
                  aria-label={messages.chat.abort}
                  title={messages.chat.abort}
                >
                  <StopSquareIcon />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSubmitActiveMessage}
                  className="ui-button-primary shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold disabled:cursor-not-allowed sm:px-3 sm:py-1.5 sm:text-[11px]"
                >
                  {messages.chat.send}
                </button>
              )}
            </div>
            {!isCreateSessionOnly && !activeSessionReadOnly ? (
              <ComposerContextUsage
                usage={contextUsage}
                loading={contextLoading}
              />
            ) : null}
          </form>
          {!isCreateSessionOnly && error ? <p className="mt-1.5 text-[11px] text-red-600">{error}</p> : null}
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
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--border-subtle)] px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={handleOpenDrawer}
              className="ui-button-secondary inline-flex size-8 shrink-0 items-center justify-center rounded-full p-0 [&>svg]:block [&>svg]:-translate-y-px lg:hidden"
              aria-label={messages.nav.openDrawer}
              title={messages.nav.openDrawer}
            >
              <ChatBubbleIcon />
            </button>
            <h2 className="truncate text-xs font-semibold text-[color:var(--text-primary)] sm:text-sm">
              {activeSession?.title ?? messages.nav.createSession}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageSwitcher locale={locale} messages={messages} />
          </div>
        </div>

        <div
          ref={messagesScrollerRef}
          onScroll={handleMessagesScroll}
          className="min-h-0 flex-1 overflow-y-auto px-1 py-1 sm:px-2 sm:py-2"
        >
          <div key={activeSessionId ?? "no-session"} className="mx-auto flex min-h-full w-full max-w-none flex-col gap-1.5">
            {pairing ? (
              <div className="max-w-[96ch] rounded-[0.9rem] border border-[color:var(--border-strong)] bg-[color:var(--surface-subtle)] px-3 py-2.5 text-[color:var(--text-primary)] sm:px-4 sm:py-3">
                <p className="text-xs font-semibold">{messages.chat.pairingTitle}</p>
                <p className="mt-1.5 text-xs text-[color:var(--text-secondary)]">
                  {messages.chat.pairingDescription}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (activeSessionId) {
                        setPairingBySession((current) => ({ ...current, [activeSessionId]: null }));
                        void loadSession(activeSessionId);
                      }
                    }}
                    className="ui-button-secondary rounded-full px-3 py-1.5 text-xs font-medium"
                  >
                    {messages.chat.retryConnection}
                  </button>
                </div>
              </div>
            ) : null}

            {isCenteredEmptyState ? (
              <div className="flex min-h-full flex-1 items-center">
                {renderComposer({
                  placement: "centered",
                  mode: activeSessionId ? "active-session" : "create-session-only",
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
          </div>
        </div>

        {showScrollToBottom ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[7.5rem] z-10 flex justify-center px-3 sm:bottom-[8.75rem]">
            <button
              type="button"
              onClick={handleScrollToBottomClick}
              className="ui-button-primary pointer-events-auto inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-medium shadow-[var(--shadow-float)]"
            >
              <span aria-hidden="true" className="text-xs leading-none">↓</span>
              <span>{loading ? messages.chat.newMessages : messages.chat.backToBottom}</span>
            </button>
          </div>
        ) : null}

        {!isCenteredEmptyState ? renderComposer({ placement: "docked", mode: "active-session" }) : null}
      </section>

      {renameTargetSession ? (
        <div className="ui-overlay fixed inset-0 z-40 flex items-center justify-center px-4">
          <button
            type="button"
            aria-label={messages.nav.closeRenameModal}
            onClick={closeRenameModal}
            className="absolute inset-0"
          />
          <div className="ui-card relative z-10 w-full max-w-md rounded-[1rem] p-4">
            <div className="mb-4">
              <p className="text-sm font-semibold text-[color:var(--text-primary)]">{messages.chat.renameSession}</p>
              <p className="mt-1 text-xs text-[color:var(--text-tertiary)]">{messages.chat.renameDescription}</p>
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
                  className="ui-input w-full rounded-[0.8rem] px-3 py-2 text-sm"
                  placeholder={messages.chat.sessionTitlePlaceholder}
                />
              </label>

              {renameError ? <p className="mt-2 text-xs text-red-600">{renameError}</p> : null}

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeRenameModal}
                  disabled={renameSubmitting}
                  className="ui-button-secondary rounded-full px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed"
                >
                  {messages.common.cancel}
                </button>
                <button
                  type="submit"
                  disabled={renameSubmitting}
                  className="ui-button-primary rounded-full px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed"
                >
                  {renameSubmitting ? messages.common.saving : messages.common.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
