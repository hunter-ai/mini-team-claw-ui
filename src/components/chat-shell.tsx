"use client";

import { useMemo, useRef, useState } from "react";
import { UserRole } from "@prisma/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatRelativeDate } from "@/lib/utils";

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

type StreamEvent =
  | {
      type: "delta";
      delta: string;
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

function MessageBody({ content, isUser }: { content: string; isUser: boolean }) {
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

export function ChatShell({
  initialSessions,
  initialActiveSessionId,
  initialMessages,
  initialAttachments,
  user,
}: {
  initialSessions: Session[];
  initialActiveSessionId: string | null;
  initialMessages: Message[];
  initialAttachments: Attachment[];
  user: UserShape;
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [text, setText] = useState("");
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const abortController = useRef<AbortController | null>(null);

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
      attachments: Attachment[];
    };
    setMessages(payload.messages);
    setAttachments(payload.attachments);
  }

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

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
    setAttachments([]);
    setPendingAttachmentIds([]);
    setDrawerOpen(false);
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !activeSessionId) {
      return;
    }

    setUploading(true);
    setError(null);
    const nextIds: string[] = [];

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
      nextIds.push(payload.attachment.id);
      setAttachments((current) => [payload.attachment, ...current]);
    }

    setPendingAttachmentIds((current) => [...current, ...nextIds]);
    setUploading(false);
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSessionId || !text.trim() || loading) {
      return;
    }
    const inputText = text;
    const attachmentIds = pendingAttachmentIds;

    const userMessage: Message = {
      id: `local-user-${Date.now()}`,
      role: "USER",
      content: inputText,
      createdAt: new Date().toISOString(),
    };
    const streamingAssistantId = `local-assistant-${Date.now()}`;
    const assistantMessage: Message = {
      id: streamingAssistantId,
      role: "ASSISTANT",
      content: "",
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setLoading(true);
    setError(null);
    setText("");
    setPendingAttachmentIds([]);
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
          setMessages(payload.messages);
          setSessions((current) =>
            current.map((session) =>
              session.id === payload.session.id ? payload.session : session,
            ),
          );
          return;
        }

        if (payload.type === "error") {
          throw new Error(payload.error);
        }
      };

      while (true) {
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

      if (buffer.trim()) {
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
    await fetch(`/api/sessions/${activeSessionId}/abort`, { method: "POST" });
    setLoading(false);
  }

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside
        className={`fixed inset-y-20 left-4 z-20 w-[calc(100vw-2rem)] overflow-y-auto rounded-[2rem] border border-white/10 bg-[#14110f]/95 p-4 shadow-[0_25px_80px_rgba(0,0,0,0.5)] transition lg:static lg:block lg:h-full lg:w-auto ${
          drawerOpen ? "translate-x-0" : "-translate-x-[115%] lg:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-amber-300/70">Workspace</p>
            <h2 className="mt-2 text-xl font-semibold text-white">{user.openclawAgentId}</h2>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="rounded-full border border-white/10 px-3 py-2 text-sm text-stone-300 lg:hidden"
          >
            Close
          </button>
        </div>
        <button
          type="button"
          onClick={createSession}
          className="mt-5 w-full rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300"
        >
          New session
        </button>
        <div className="mt-5 space-y-3">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  setActiveSessionId(session.id);
                  void loadSession(session.id);
                  setDrawerOpen(false);
                }}
                className={`w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
                  isActive
                    ? "border-amber-400/80 bg-amber-400/10"
                    : "border-white/8 bg-black/20 hover:border-white/20"
                }`}
              >
                <p className="truncate font-medium text-stone-100">{session.title}</p>
                <p className="mt-1 text-xs text-stone-400">
                  {formatRelativeDate(session.lastMessageAt ?? session.updatedAt)}
                </p>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-white/5 shadow-[0_25px_80px_rgba(0,0,0,0.35)]">
        <div className="flex shrink-0 items-center justify-between border-b border-white/8 px-4 py-4">
          <div>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-full border border-white/10 px-3 py-2 text-sm text-stone-300 lg:hidden"
            >
              Sessions
            </button>
            <h2 className="mt-3 text-xl font-semibold text-white lg:mt-0">
              {activeSession?.title ?? "Create a session"}
            </h2>
            <p className="text-sm text-stone-400">
              {user.username} · {user.role === "ADMIN" ? "admin" : "member"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {loading ? (
              <button
                type="button"
                onClick={abortSession}
                className="rounded-full border border-rose-400/60 px-3 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-300"
              >
                Abort
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {messages.length ? null : (
            <div className="rounded-[1.8rem] border border-dashed border-white/12 bg-black/15 p-6 text-sm text-stone-400">
              Each session maps to the same OpenClaw agent but keeps a separate session key. Use
              attachments when you need the host gateway to inspect files.
            </div>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`max-w-3xl rounded-[1.8rem] px-4 py-4 ${
                message.role === "USER"
                  ? "ml-auto bg-amber-400 text-stone-950"
                  : "bg-black/25 text-stone-100"
              }`}
            >
              <div>
                <MessageBody content={message.content} isUser={message.role === "USER"} />
                {loading &&
                message.id === messages[messages.length - 1]?.id &&
                message.role === "ASSISTANT" ? (
                  <StreamingSpinner />
                ) : null}
              </div>
              <p
                className={`mt-2 text-xs ${
                  message.role === "USER" ? "text-stone-700" : "text-stone-500"
                }`}
              >
                {formatRelativeDate(message.createdAt)}
              </p>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-white/8 p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.slice(0, 6).map((attachment) => {
              const pending = pendingAttachmentIds.includes(attachment.id);
              return (
                <span
                  key={attachment.id}
                  className={`rounded-full px-3 py-2 text-xs ${
                    pending ? "bg-amber-400/20 text-amber-200" : "bg-black/20 text-stone-400"
                  }`}
                >
                  {attachment.originalName}
                </span>
              );
            })}
          </div>
          <form onSubmit={sendMessage} className="space-y-3">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={5}
              placeholder="Ask with or without attachments..."
              className="w-full rounded-[1.6rem] border border-white/10 bg-black/25 px-4 py-4 text-stone-100 outline-none placeholder:text-stone-500 focus:border-amber-400"
              disabled={!activeSessionId || loading}
            />
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <label className="inline-flex cursor-pointer items-center gap-3 rounded-full border border-white/10 px-4 py-2 text-sm text-stone-200 transition hover:border-amber-400">
                <input
                  type="file"
                  className="hidden"
                  multiple
                  disabled={!activeSessionId || uploading}
                  onChange={(event) => void uploadFiles(event.target.files)}
                />
                {uploading ? "Uploading..." : "Attach files"}
              </label>
              <button
                type="submit"
                disabled={!activeSessionId || loading || uploading || !text.trim()}
                className="rounded-full bg-amber-400 px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-amber-100"
              >
                {loading ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
          {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}
