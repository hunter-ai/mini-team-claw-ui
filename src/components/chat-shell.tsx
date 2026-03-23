"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UserRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatRelativeDate } from "@/lib/utils";
import { LogoutButton } from "@/components/logout-button";

type Session = {
  id: string;
  title: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

type Message = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
  attachments: Attachment[];
};

type Attachment = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
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

type StreamEvent =
  | {
      type: "delta";
      delta: string;
    }
  | {
      type: "pairing_required";
      pairing: {
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
    }
  | {
      type: "done";
      session: Session;
      assistantMessage: Message;
      messages: Message[];
    }
  | {
      type: "error";
      error: string;
    };

function parseStreamEvent(line: string) {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    throw new Error(`Invalid stream payload: ${line.slice(0, 160)}`);
  }
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

function MessageBody({ content, isUser }: { content: string; isUser: boolean }) {
  if (!content.trim()) {
    return null;
  }

  if (isUser) {
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
  user,
}: {
  initialSessions: Session[];
  initialHasMore: boolean;
  initialNextCursor: string | null;
  initialActiveSessionId: string | null;
  initialMessages: Message[];
  user: UserShape;
}) {
  const pageSize = 30;
  const [sessions, setSessions] = useState(initialSessions);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [text, setText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [pairing, setPairing] = useState<Extract<StreamEvent, { type: "pairing_required" }>["pairing"] | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const sessionsScrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollerRef = useRef<HTMLDivElement | null>(null);
  const shouldSnapMessagesToBottomRef = useRef(true);
  const shouldStickMessagesToBottomRef = useRef(false);
  const isProgrammaticMessagesScrollRef = useRef(false);

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

  async function loadSession(sessionId: string) {
    setError(null);
    const response = await fetch(`/api/sessions/${sessionId}/messages`, {
      cache: "no-store",
    });
    if (!response.ok) {
      setError("Failed to load session");
      return;
    }

    const payload = (await response.json()) as {
      session: { id: string };
      messages: Message[];
    };
    setMessages(payload.messages);
    setPendingAttachments([]);
  }

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

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
  }, [messages, syncMessagesToBottom]);

  async function selectSession(sessionId: string) {
    setPairing(null);
    setShowScrollToBottom(false);
    setActiveSessionId(sessionId);
    setPendingAttachments([]);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
    await loadSession(sessionId);
  }

  async function createSession() {
    setError(null);
    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) {
      setError("Failed to create session");
      return;
    }
    const payload = (await response.json()) as { session: Session };
    setSessions((current) => [payload.session, ...current]);
    setActiveSessionId(payload.session.id);
    setMessages([]);
    setPendingAttachments([]);
    setPairing(null);
    setShowScrollToBottom(false);
    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = false;
    setDrawerOpen(false);
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !activeSessionId) {
      return;
    }

    setUploading(true);
    setError(null);
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
        setError(payload.error ?? `Upload failed for ${file.name}`);
        continue;
      }

      const payload = (await response.json()) as { attachment: Attachment };
      nextAttachments.push(payload.attachment);
    }

    setPendingAttachments((current) => [...current, ...nextAttachments]);
    setUploading(false);
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedText = text.trim();
    if (!activeSessionId || loading || (!trimmedText && pendingAttachments.length === 0)) {
      return;
    }
    const inputText = trimmedText ? text : "";
    const selectedAttachments = pendingAttachments;
    const attachmentIds = selectedAttachments.map((attachment) => attachment.id);

    const userMessage: Message = {
      id: `local-user-${Date.now()}`,
      role: "USER",
      content: inputText,
      createdAt: new Date().toISOString(),
      attachments: selectedAttachments,
    };
    const streamingAssistantId = `local-assistant-${Date.now()}`;
    const assistantMessage: Message = {
      id: streamingAssistantId,
      role: "ASSISTANT",
      content: "",
      createdAt: new Date().toISOString(),
      attachments: [],
    };

    shouldSnapMessagesToBottomRef.current = true;
    shouldStickMessagesToBottomRef.current = true;
    setShowScrollToBottom(false);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setLoading(true);
    setError(null);
    setPairing(null);
    setText("");
    setPendingAttachments([]);
    abortController.current = new AbortController();

    const response = await fetch(`/api/sessions/${activeSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: inputText,
        attachmentIds,
      }),
      signal: abortController.current.signal,
    }).catch((fetchError) => fetchError);

    if (response instanceof Error) {
      setLoading(false);
      setError(response.message);
      await loadSession(activeSessionId);
      return;
    }

    if (!response.ok) {
      setLoading(false);
      const raw = await response.text().catch(() => "");
      let errorMessage = "Failed to send";

      if (raw) {
        try {
          const payload = JSON.parse(raw) as { error?: string };
          errorMessage = payload.error ?? errorMessage;
        } catch {
          errorMessage = raw;
        }
      }

      setError(errorMessage);
      await loadSession(activeSessionId);
      return;
    }

    if (!response.body) {
      setLoading(false);
      setError("Streaming response body missing");
      await loadSession(activeSessionId);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamFinished = false;

    try {
      const consumeLine = (line: string) => {
        if (!line.trim()) {
          return;
        }

        const payload = parseStreamEvent(line);
        if (payload.type === "delta") {
          setMessages((current) =>
            current.map((message) =>
              message.id === streamingAssistantId
                ? { ...message, content: message.content + payload.delta }
                : message,
            ),
          );
          return;
        }

        if (payload.type === "done") {
          shouldSnapMessagesToBottomRef.current = shouldStickMessagesToBottomRef.current;
          shouldStickMessagesToBottomRef.current = false;
          setShowScrollToBottom(false);
          setMessages(payload.messages);
          setPendingAttachments([]);
          setSessions((current) =>
            current.map((session) =>
              session.id === payload.session.id ? payload.session : session,
            ),
          );
          streamFinished = true;
          setLoading(false);
          return;
        }

        if (payload.type === "pairing_required") {
          shouldStickMessagesToBottomRef.current = false;
          setShowScrollToBottom(false);
          setPairing(payload.pairing);
          setMessages((current) => current.filter((message) => message.id !== streamingAssistantId));
          streamFinished = true;
          setLoading(false);
          void loadSession(activeSessionId);
          return;
        }

        if (payload.type === "error") {
          streamFinished = true;
          throw new Error(payload.error);
        }
      };

      while (true) {
        if (streamFinished) {
          break;
        }

        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        if (done) {
          break;
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          consumeLine(line);
        }
      }

      if (!streamFinished && buffer.trim()) {
        consumeLine(buffer);
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "Failed to stream");
      await loadSession(activeSessionId);
    } finally {
      setLoading(false);
      reader.releaseLock();
    }
  }

  async function abortSession() {
    if (!activeSessionId) {
      return;
    }

    abortController.current?.abort();
    shouldStickMessagesToBottomRef.current = false;
    setShowScrollToBottom(false);
    await fetch(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setLoading(false);
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
                    <>
                      <p className="truncate text-xs font-medium text-stone-100">{session.title}</p>
                    </>
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
                      setPairing(null);
                      if (activeSessionId) {
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

            {messages.length ? null : (
              <div className="flex min-h-full flex-1 items-center justify-center py-4">
                <button
                  type="button"
                  onClick={createSession}
                  className="rounded-full border border-white/10 bg-black/20 px-4 py-2 text-xs text-stone-300 transition hover:border-amber-400 hover:text-amber-100"
                >
                  New session
                </button>
              </div>
            )}

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
                  {loading &&
                  message.id === messages[messages.length - 1]?.id &&
                  message.role === "ASSISTANT" ? (
                    <StreamingSpinner />
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
                  onChange={(event) => setText(event.target.value)}
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
