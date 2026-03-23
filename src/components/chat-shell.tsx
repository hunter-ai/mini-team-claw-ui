"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UserRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ClientChatRunEvent } from "@/lib/chat-run-events";
import { formatRelativeDate } from "@/lib/utils";
import { LogoutButton } from "@/components/logout-button";

type Attachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
};

type Message = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
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

function isRunBusy(state: RunState) {
  return state === "starting" || state === "streaming" || state === "reconnecting";
}

function parseSsePayload(input: string) {
  return JSON.parse(input) as StreamPayload;
}

function AttachmentBadge({
  attachment,
  tone = "composer",
}: {
  attachment: Attachment;
  tone?: "composer" | "user-message" | "assistant-message";
}) {
  const styles =
    tone === "user-message"
      ? {
          outer:
            "border-stone-950/14 bg-[linear-gradient(180deg,rgba(255,248,235,0.94),rgba(247,233,205,0.88))] text-stone-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]",
          meta: "text-stone-700/80",
        }
      : tone === "assistant-message"
        ? {
            outer:
              "border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] text-stone-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
            meta: "text-stone-400",
          }
        : {
            outer:
              "border-amber-300/25 bg-[linear-gradient(180deg,rgba(251,191,36,0.2),rgba(251,146,60,0.12))] text-amber-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
            meta: "text-amber-100/70",
          };

  return (
    <span
      className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-[0.9rem] border px-2.5 py-1.5 text-[10px] leading-tight sm:px-3 sm:text-[11px] ${styles.outer}`}
    >
      <span className="max-w-full truncate font-semibold">{attachment.originalName}</span>
      <span className={`text-[0.92em] ${styles.meta}`}>
        {attachment.mime || "unknown"} · {formatFileSize(attachment.size)}
      </span>
    </span>
  );
}

function MessageBody({
  content,
  isUser,
  streaming = false,
}: {
  content: string;
  isUser: boolean;
  streaming?: boolean;
}) {
  if (!content.trim()) {
    return null;
  }

  if (isUser) {
    return <p className="whitespace-pre-wrap text-sm leading-7">{content}</p>;
  }

  if (streaming) {
    return <p className="whitespace-pre-wrap text-sm leading-7">{content}</p>;
  }

  return (
    <div className="markdown-body text-sm leading-7">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function StreamingSpinner() {
  return (
    <span
      aria-label="Streaming"
      className="ml-2 inline-block size-3 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-300 align-middle"
    />
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return <span aria-hidden="true" className="text-sm leading-none">{collapsed ? "»" : "«"}</span>;
}

export function ChatShell({
  initialSessions,
  initialHasMore,
  initialNextCursor,
  initialActiveSessionId,
  initialMessages,
  initialActiveRun,
  user,
}: {
  initialSessions: Session[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  initialActiveSessionId: string | null;
  initialMessages: Message[];
  initialActiveRun: SessionRun | null;
  user: UserShape;
}) {
  const pageSize = 30;
  const pathname = usePathname();
  const [sessions, setSessions] = useState(initialSessions);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, Message[]>>(
    initialActiveSessionId ? { [initialActiveSessionId]: initialMessages } : {},
  );
  const [composerBySession, setComposerBySession] = useState<Record<string, string>>({});
  const [pendingAttachmentsBySession, setPendingAttachmentsBySession] = useState<Record<string, Attachment[]>>({});
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
  const [loadedSessionIds, setLoadedSessionIds] = useState<Record<string, boolean>>(
    initialActiveSessionId ? { [initialActiveSessionId]: true } : {},
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const sessionsScrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollerRef = useRef<HTMLDivElement | null>(null);
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
  const activeRunBySessionRef = useRef<Record<string, SessionRun | null>>(
    initialActiveSessionId && initialActiveRun ? { [initialActiveSessionId]: initialActiveRun } : {},
  );
  const loadSessionRef = useRef<(sessionId: string, clearError?: boolean) => Promise<void>>(async () => {});

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const messages = useMemo(
    () => (activeSessionId ? messagesBySession[activeSessionId] ?? [] : []),
    [activeSessionId, messagesBySession],
  );
  const text = activeSessionId ? composerBySession[activeSessionId] ?? "" : "";
  const pendingAttachments = activeSessionId ? pendingAttachmentsBySession[activeSessionId] ?? [] : [];
  const activeRun = activeSessionId ? activeRunBySession[activeSessionId] ?? null : null;
  const loading = activeSessionId ? isRunBusy(runStateBySession[activeSessionId] ?? "idle") : false;
  const uploading = activeSessionId ? uploadingBySession[activeSessionId] ?? false : false;
  const error = activeSessionId ? errorBySession[activeSessionId] ?? null : null;
  const pairing = activeSessionId ? pairingBySession[activeSessionId] ?? null : null;
  const visibleDraftKey = activeRun
    ? `${activeRun.id}:${activeRun.draftAssistantContent}:${activeRun.status}:${runStateBySession[activeSessionId ?? ""] ?? "idle"}`
    : "idle";

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
      `/api/sessions/${sessionId}/runs/${run.id}/stream?afterSeq=${encodeURIComponent(String(afterSeq))}`,
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
        setRunStateBySession((current) => ({ ...current, [sessionId]: "streaming" }));
        updateActiveRun(sessionId, {
          ...(activeRunBySessionRef.current[sessionId] ?? run),
          id: run.id,
          status: "STREAMING",
          lastEventSeq: payload.seq,
        });
        return;
      }

      if (payload.type === "delta") {
        setRunStateBySession((current) => ({ ...current, [sessionId]: "streaming" }));
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
          updatedAt: new Date().toISOString(),
        };
        scheduleBufferedRunPatchFlush(sessionId, currentRun);
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

      if (payload.type === "done") {
        setRunStateBySession((current) => ({ ...current, [sessionId]: "completed" }));
        setErrorBySession((current) => ({ ...current, [sessionId]: null }));
        setPairingBySession((current) => ({ ...current, [sessionId]: null }));
      } else if (payload.type === "aborted") {
        setRunStateBySession((current) => ({ ...current, [sessionId]: "aborted" }));
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.reason }));
      } else if (payload.type === "pairing_required") {
        setRunStateBySession((current) => ({ ...current, [sessionId]: "failed" }));
        setPairingBySession((current) => ({ ...current, [sessionId]: payload.pairing }));
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.pairing.message }));
      } else {
        setRunStateBySession((current) => ({ ...current, [sessionId]: "failed" }));
        setErrorBySession((current) => ({ ...current, [sessionId]: payload.error }));
      }

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
        setRunStateBySession((current) => ({ ...current, [sessionId]: "failed" }));
        setErrorBySession((current) => ({
          ...current,
          [sessionId]: "Connection to the active response was lost. Refresh this session to recover.",
        }));
        return;
      }

      logChatShellDebug("[chat-debug][chat-shell] EventSource scheduling reconnect", {
        sessionId,
        runId: run.id,
        nextAttempt,
        afterSeq: lastEventSeqByRunRef.current[run.id] ?? run.lastEventSeq ?? 0,
      });
      setRunStateBySession((current) => ({ ...current, [sessionId]: "reconnecting" }));
      reconnectTimersRef.current[run.id] = window.setTimeout(() => {
        subscribeToRun(sessionId, latestRun);
      }, Math.min(1000 * nextAttempt, 4000));
    };
  }, [flushBufferedRunPatch, scheduleBufferedRunPatchFlush, updateActiveRun]);

  const loadSession = useCallback(async (sessionId: string, clearError = true) => {
    logChatShellDebug("[chat-debug][chat-shell] loading session", {
      sessionId,
      clearError,
      activeSessionId: activeSessionIdRef.current,
    });

    if (clearError) {
      setErrorBySession((current) => ({ ...current, [sessionId]: null }));
    }

    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      cache: "no-store",
    });

    if (!response.ok) {
      setErrorBySession((current) => ({ ...current, [sessionId]: "Failed to load session" }));
      return;
    }

    const payload = (await response.json()) as {
      session: Session;
      messages: Message[];
      activeRun: SessionRun | null;
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

    let nextMessages = payload.messages;
    if (
      payload.activeRun &&
      !payload.activeRun.assistantMessageId &&
      payload.activeRun.draftAssistantContent.trim() &&
      ["FAILED", "ABORTED"].includes(payload.activeRun.status)
    ) {
      nextMessages = [
        ...payload.messages,
        {
          id: `draft-run:${payload.activeRun.id}`,
          role: "ASSISTANT",
          content: payload.activeRun.draftAssistantContent,
          createdAt: payload.activeRun.updatedAt,
          attachments: [],
        },
      ];
    }

    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: nextMessages,
    }));
    setLoadedSessionIds((current) => ({ ...current, [sessionId]: true }));
    updateSessionSummary(payload.session);
    updateActiveRun(sessionId, payload.activeRun);

    const nextState = payload.activeRun ? mapRunStatusToState(payload.activeRun.status) : "idle";
    setRunStateBySession((current) => ({ ...current, [sessionId]: nextState }));

    if (!payload.activeRun) {
      setPairingBySession((current) => ({ ...current, [sessionId]: null }));
      return;
    }

    lastEventSeqByRunRef.current[payload.activeRun.id] = payload.activeRun.lastEventSeq;

    if (["STARTING", "STREAMING"].includes(payload.activeRun.status)) {
      subscribeToRun(sessionId, payload.activeRun);
    }
  }, [subscribeToRun, updateActiveRun, updateSessionSummary]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  const loadMoreSessions = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) {
      return;
    }

    setLoadingMore(true);
    setLoadMoreError(null);

    try {
      const response = await fetch(
        `/api/sessions?limit=${pageSize}&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error("Failed to load more sessions");
      }

      const payload = (await response.json()) as {
        sessions: Session[];
        pageInfo: SessionsPageInfo;
      };

      setSessions((current) => {
        const seen = new Set(current.map((session) => session.id));
        const incoming = payload.sessions.filter((session) => !seen.has(session.id));
        return [...current, ...incoming];
      });
      setHasMore(payload.pageInfo.hasMore);
      setNextCursor(payload.pageInfo.nextCursor);
    } catch (loadError) {
      setLoadMoreError(loadError instanceof Error ? loadError.message : "Failed to load more sessions");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, nextCursor, pageSize]);

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

    syncMessagesToBottom();
    shouldSnapMessagesToBottomRef.current = false;
  }, [messages, syncMessagesToBottom, visibleDraftKey]);

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

  async function selectSession(sessionId: string) {
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
    if (run) {
      flushBufferedRunPatch(sessionId, run);
    }
    if (run && ["STARTING", "STREAMING"].includes(run.status)) {
      subscribeToRun(sessionId, run);
    }
  }

  async function createSession() {
    logChatShellDebug("[chat-debug][chat-shell] creating session", {
      currentActiveSessionId: activeSessionId,
    });
    setErrorBySession((current) => ({
      ...current,
      [activeSessionId ?? ""]: null,
    }));

    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) {
      if (activeSessionId) {
        setErrorBySession((current) => ({ ...current, [activeSessionId]: "Failed to create session" }));
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
    setLoadedSessionIds((current) => ({ ...current, [payload.session.id]: true }));
    updateActiveRun(payload.session.id, null);
    setRunStateBySession((current) => ({ ...current, [payload.session.id]: "idle" }));
    setPendingAttachmentsBySession((current) => ({ ...current, [payload.session.id]: [] }));
    setComposerBySession((current) => ({ ...current, [payload.session.id]: "" }));
    setPairingBySession((current) => ({ ...current, [payload.session.id]: null }));
    setShowScrollToBottom(false);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
    syncSessionUrl(payload.session.id);
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !activeSessionId) {
      return;
    }

    setUploadingBySession((current) => ({ ...current, [activeSessionId]: true }));
    setErrorBySession((current) => ({ ...current, [activeSessionId]: null }));
    const nextAttachments: Attachment[] = [];

    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sessionId", activeSessionId);

      const response = await fetch("/api/attachments", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setErrorBySession((current) => ({
          ...current,
          [activeSessionId]: payload.error ?? `Upload failed for ${file.name}`,
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

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeSessionId || loading) {
      return;
    }

    const currentText = composerBySession[activeSessionId] ?? "";
    const trimmedText = currentText.trim();
    const selectedAttachments = pendingAttachmentsBySession[activeSessionId] ?? [];

    if (!trimmedText && selectedAttachments.length === 0) {
      return;
    }

    const inputText = trimmedText ? currentText : "";
    const attachmentIds = selectedAttachments.map((attachment) => attachment.id);
    const clientRequestId = crypto.randomUUID();
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
          attachments: selectedAttachments,
        },
      ],
    }));
    setComposerBySession((current) => ({ ...current, [targetSessionId]: "" }));
    setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: [] }));
    setRunStateBySession((current) => ({ ...current, [targetSessionId]: "starting" }));
    setErrorBySession((current) => ({ ...current, [targetSessionId]: null }));
    setPairingBySession((current) => ({ ...current, [targetSessionId]: null }));
    updateActiveRun(targetSessionId, optimisticRun);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = true;
    setShowScrollToBottom(false);

    const response = await fetch(`/api/sessions/${targetSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: inputText,
        attachmentIds,
        clientRequestId,
      }),
    }).catch((fetchError) => fetchError);

    if (response instanceof Error) {
      logChatShellDebug("[chat-debug][chat-shell] send failed before response", {
        sessionId: targetSessionId,
        clientRequestId,
        error: response.message,
      });
      setRunStateBySession((current) => ({ ...current, [targetSessionId]: "failed" }));
      setErrorBySession((current) => ({ ...current, [targetSessionId]: response.message }));
      setComposerBySession((current) => ({ ...current, [targetSessionId]: inputText }));
      setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: selectedAttachments }));
      await loadSession(targetSessionId, false);
      return;
    }

    const rawText = await response.text();
    if (!response.ok) {
      let errorMessage = "Failed to send";
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
      setRunStateBySession((current) => ({ ...current, [targetSessionId]: "failed" }));
      setErrorBySession((current) => ({ ...current, [targetSessionId]: errorMessage }));
      setComposerBySession((current) => ({ ...current, [targetSessionId]: inputText }));
      setPendingAttachmentsBySession((current) => ({ ...current, [targetSessionId]: selectedAttachments }));
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
      setRunStateBySession((current) => ({ ...current, [targetSessionId]: "idle" }));
      return;
    }

    const run = payload.run;
    updateActiveRun(targetSessionId, run);
    setRunStateBySession((current) => ({
      ...current,
      [targetSessionId]: mapRunStatusToState(run.status),
    }));
    lastEventSeqByRunRef.current[run.id] = run.lastEventSeq;

    if (["STARTING", "STREAMING"].includes(run.status)) {
      subscribeToRun(targetSessionId, run);
    } else {
      await loadSession(targetSessionId, false);
    }
  }

  async function abortSession() {
    if (!activeSessionId) {
      return;
    }

    shouldStickMessagesToBottomRef.current = false;
    setShowScrollToBottom(false);
    await fetch(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setRunStateBySession((current) => ({ ...current, [activeSessionId]: "aborted" }));
  }

  function handleMessagesScroll() {
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
  }

  function handleScrollToBottomClick() {
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = loading;
    setShowScrollToBottom(false);
    syncMessagesToBottom("smooth");
  }

  return (
    <div className="relative grid h-full min-h-0 gap-1.5 lg:grid-cols-[auto_minmax(0,1fr)]">
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close sessions drawer"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-20 bg-black/55 lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-1.5 left-1.5 z-30 flex w-[calc(100vw-0.75rem)] max-w-[20rem] shrink-0 flex-col overflow-hidden rounded-[1rem] border border-white/8 bg-[#120f0df7] shadow-[0_25px_80px_rgba(0,0,0,0.5)] transition-[width,transform] duration-300 lg:static lg:inset-auto lg:z-auto lg:h-full lg:max-w-none lg:rounded-[0.9rem] ${
          drawerOpen ? "translate-x-0" : "-translate-x-[108%] lg:translate-x-0"
        } ${isSidebarCollapsed ? "lg:w-[3.5rem]" : "lg:w-[14.5rem] xl:w-[15.25rem]"}`}
      >
        <div className="border-b border-white/8 px-2 py-1.5 sm:px-2.5">
          {isSidebarCollapsed ? (
            <div className="hidden justify-center lg:flex">
              <button
                type="button"
                onClick={() => setIsSidebarCollapsed(false)}
                className="inline-flex size-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs text-stone-300 transition hover:border-amber-400 hover:text-amber-100"
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <SidebarToggleIcon collapsed />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-stone-100">{user.openclawAgentId}</p>
                  <p className="mt-0.5 truncate text-[10px] text-stone-500">{user.username}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsSidebarCollapsed(true)}
                    className="hidden size-8 items-center justify-center rounded-full border border-white/10 text-xs text-stone-300 transition hover:border-amber-400 hover:text-amber-100 lg:inline-flex"
                    aria-label="Collapse sidebar"
                    title="Collapse sidebar"
                  >
                    <SidebarToggleIcon collapsed={false} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDrawerOpen(false)}
                    className="rounded-full border border-white/10 px-2.5 py-1.5 text-xs text-stone-300 lg:hidden"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={createSession}
                  className="min-w-0 flex-1 rounded-[0.7rem] border border-amber-300/20 bg-amber-400 px-2.5 py-1.5 text-[11px] font-semibold text-stone-950 transition hover:bg-amber-300"
                >
                  New
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
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const runState = runStateBySession[session.id] ?? mapRunStatusToState(session.activeRun?.status);
              const isBusy = isRunBusy(runState);

              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void selectSession(session.id)}
                  title={isSidebarCollapsed ? session.title : undefined}
                  className={`w-full rounded-[0.75rem] border text-left transition ${
                    isSidebarCollapsed ? "px-1.5 py-2 lg:min-h-10" : "px-2 py-2"
                  } ${
                    isActive
                      ? "border-amber-400/70 bg-amber-400/10"
                      : "border-white/8 bg-black/20 hover:border-white/20 hover:bg-white/[0.04]"
                  }`}
                >
                  {isSidebarCollapsed ? (
                    <div className="flex items-center justify-center">
                      <span className="flex size-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[11px] font-semibold uppercase text-stone-200">
                        {session.title.slice(0, 1)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-medium text-stone-100">{session.title}</p>
                      {isBusy ? (
                        <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-100">
                          Live
                        </span>
                      ) : null}
                    </div>
                  )}
                </button>
              );
            })}
            <div ref={loadMoreSentinelRef} className="h-2 w-full" />
            {isSidebarCollapsed ? null : (
              <div className="px-1 py-1 text-center text-[10px] text-stone-500">
                {loadingMore ? (
                  <span>Loading…</span>
                ) : loadMoreError ? (
                  <button
                    type="button"
                    onClick={() => void loadMoreSessions()}
                    className="text-stone-300 transition hover:text-amber-100"
                  >
                    Retry loading
                  </button>
                ) : hasMore ? null : sessions.length ? (
                  <span>No more sessions</span>
                ) : null}
              </div>
            )}
          </div>
        </div>

        {isSidebarCollapsed ? null : (
          <div className="border-t border-white/8 px-2 py-1.5 sm:px-2.5">
            <div className="grid grid-cols-2 gap-1.5">
              {user.role === "ADMIN" ? (
                <Link
                  href="/admin"
                  className="inline-flex h-8 items-center justify-center rounded-[0.7rem] border border-white/10 px-2.5 text-[11px] font-medium text-stone-300 transition hover:border-amber-400 hover:text-amber-100"
                >
                  Admin
                </Link>
              ) : (
                <span className="hidden" aria-hidden="true" />
              )}
              <LogoutButton
                className={`inline-flex h-8 items-center justify-center rounded-[0.7rem] border border-white/10 px-2.5 text-[11px] font-medium text-stone-300 transition hover:border-amber-400/80 hover:text-amber-200 ${
                  user.role === "ADMIN" ? "" : "col-span-2"
                }`}
              />
            </div>
          </div>
        )}
      </aside>

      <section
        aria-label={`Chat workspace for ${user.openclawAgentId}`}
        className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[0.9rem] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(0,0,0,0.06))] shadow-[0_25px_80px_rgba(0,0,0,0.24)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-full border border-white/10 px-2.5 py-1.5 text-xs text-stone-300 lg:hidden"
            >
              Sessions
            </button>
            <h2 className="truncate text-xs font-semibold text-white sm:text-sm">
              {activeSession?.title ?? "Create a session"}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {loading ? (
              <button
                type="button"
                onClick={abortSession}
                className="rounded-full border border-rose-400/60 px-2.5 py-1.5 text-xs font-medium text-rose-200 transition hover:border-rose-300"
              >
                Abort
              </button>
            ) : null}
          </div>
        </div>

        <div
          ref={messagesScrollerRef}
          onScroll={handleMessagesScroll}
          className="min-h-0 flex-1 overflow-y-auto px-1 py-1 sm:px-2 sm:py-2"
        >
          <div className="mx-auto flex min-h-full w-full max-w-none flex-col gap-1.5">
            {pairing ? (
              <div className="max-w-[96ch] rounded-[0.9rem] border border-amber-400/20 bg-amber-400/10 px-3 py-2.5 text-amber-100 sm:px-4 sm:py-3">
                <p className="text-xs font-semibold">当前设备尚未完成绑定</p>
                <p className="mt-1.5 text-xs text-amber-100/80">
                  请联系管理员进行设备绑定，完成后即可继续使用。
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
                    className="rounded-full border border-amber-100/30 px-3 py-1.5 text-xs font-medium text-amber-50 transition hover:border-amber-100/60"
                  >
                    Retry connection
                  </button>
                </div>
              </div>
            ) : null}

            {messages.length === 0 && !activeRun ? (
              <div className="flex min-h-full flex-1 items-center justify-center py-4">
                <button
                  type="button"
                  onClick={createSession}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs text-stone-300 transition hover:border-amber-400 hover:text-amber-100"
                >
                  New session
                </button>
              </div>
            ) : null}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-[0.8rem] border px-2 py-1.75 sm:px-3 sm:py-2 ${
                  message.role === "USER"
                    ? "ml-auto w-fit max-w-[min(100%,44rem)] border-amber-300/30 bg-amber-400 text-stone-950"
                    : "w-full max-w-[min(124ch,100%)] border-white/8 bg-black/25 text-stone-100"
                }`}
              >
                <div>
                  <MessageBody content={message.content} isUser={message.role === "USER"} />
                  {message.attachments.length ? (
                    <div
                      className={`mt-2 flex flex-wrap gap-1.5 border-t pt-2 ${
                        message.role === "USER" ? "border-stone-950/12" : "border-white/8"
                      }`}
                    >
                      {message.attachments.map((attachment) => (
                        <AttachmentBadge
                          key={attachment.id}
                          attachment={attachment}
                          tone={message.role === "USER" ? "user-message" : "assistant-message"}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                <p
                  className={`mt-1 text-[10px] ${
                    message.role === "USER" ? "text-stone-700" : "text-stone-500"
                  }`}
                >
                  {formatRelativeDate(message.createdAt)}
                </p>
              </div>
            ))}

            {activeRun ? (
              <div className="w-full max-w-[min(124ch,100%)] rounded-[0.8rem] border border-white/8 bg-black/25 px-2 py-1.75 text-stone-100 sm:px-3 sm:py-2">
                <div>
                  <MessageBody
                    content={activeRun.draftAssistantContent}
                    isUser={false}
                    streaming={loading || activeRun.status === "STARTING" || activeRun.status === "STREAMING"}
                  />
                  {loading || activeRun.status === "STARTING" || activeRun.status === "STREAMING" ? <StreamingSpinner /> : null}
                </div>
                <p className="mt-1 text-[10px] text-stone-500">
                  {activeRun.status === "ABORTED"
                    ? "Interrupted"
                    : activeRun.status === "FAILED"
                      ? activeRun.errorMessage ?? "Failed"
                      : formatRelativeDate(activeRun.updatedAt)}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {showScrollToBottom ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[7.5rem] z-10 flex justify-center px-3 sm:bottom-[8.75rem]">
            <button
              type="button"
              onClick={handleScrollToBottomClick}
              className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-[#18120df2] px-3 py-1.5 text-[11px] font-medium text-amber-100 shadow-[0_12px_30px_rgba(0,0,0,0.35)] transition hover:border-amber-300/60 hover:bg-[#21170ff2]"
            >
              <span aria-hidden="true" className="text-xs leading-none">↓</span>
              <span>{loading ? "New messages" : "Back to bottom"}</span>
            </button>
          </div>
        ) : null}

        <div className="shrink-0 border-t border-white/8 bg-black/20 px-1 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:px-2 sm:py-2">
          <div className="mx-auto w-full max-w-none">
            <div className="rounded-[0.85rem] border border-white/10 bg-[#0f0d0cf0] px-1.5 py-1.5 sm:px-2 sm:py-2">
              {pendingAttachments.length ? (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {pendingAttachments.map((attachment) => (
                    <AttachmentBadge key={attachment.id} attachment={attachment} tone="composer" />
                  ))}
                </div>
              ) : null}
              <form onSubmit={sendMessage} className="px-0.5 py-0.5">
                <textarea
                  value={text}
                  onChange={(event) => {
                    if (!activeSessionId) {
                      return;
                    }
                    const value = event.target.value;
                    setComposerBySession((current) => ({ ...current, [activeSessionId]: value }));
                  }}
                  rows={2}
                  placeholder="Message the agent..."
                  className="min-h-[3rem] w-full resize-none bg-transparent px-0 py-0 text-[15px] leading-5 text-stone-100 outline-none placeholder:text-stone-500 sm:min-h-[3.25rem] sm:text-sm sm:leading-6"
                  disabled={!activeSessionId || loading}
                />
                <div className="mt-1.5 flex items-center justify-between gap-1.5 border-t border-white/8 pt-1.5">
                  <div className="min-w-0 flex flex-wrap items-center gap-1">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-stone-200 transition hover:border-amber-400 sm:px-2.5 sm:text-[11px]">
                      <input
                        type="file"
                        className="hidden"
                        multiple
                        disabled={!activeSessionId || uploading || loading}
                        onChange={(event) => {
                          void uploadFiles(event.target.files);
                          event.target.value = "";
                        }}
                      />
                      {uploading ? "Uploading..." : "Attach"}
                    </label>
                  </div>
                  <button
                    type="submit"
                    disabled={
                      !activeSessionId ||
                      loading ||
                      uploading ||
                      (!text.trim() && pendingAttachments.length === 0)
                    }
                    className="shrink-0 rounded-full bg-amber-400 px-3 py-1 text-[10px] font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-amber-100 sm:px-3 sm:py-1.5 sm:text-[11px]"
                  >
                    {loading ? "Sending..." : "Send"}
                  </button>
                </div>
              </form>
              {error ? <p className="mt-1.5 text-[11px] text-rose-300">{error}</p> : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
