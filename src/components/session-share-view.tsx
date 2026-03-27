import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "@/components/code-block";
import type { SessionShareSnapshot } from "@/lib/session-share";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import { getLifecycleTitle } from "@/lib/i18n/messages";
import { formatRelativeDate } from "@/lib/utils";

const sharePageBackground = [
  "radial-gradient(circle at top left, rgba(255,255,255,0.85), transparent 22%)",
  "radial-gradient(circle at right 12% top 16%, rgba(148,163,184,0.16), transparent 18%)",
  "linear-gradient(180deg, rgba(248,250,252,0.92) 0%, rgba(243,244,246,0.96) 44%, rgba(238,242,247,0.98) 100%)",
].join(", ");

const userBubbleClassName =
  "ml-auto w-fit max-w-[min(100%,44rem)] border-[rgba(17,24,39,0.18)] bg-[#d1d5db] text-[color:var(--text-primary)] shadow-[0_8px_20px_rgba(15,23,42,0.08)]";
const assistantBubbleClassName =
  "mr-auto self-start max-w-[min(124ch,calc(100%-2.5rem))] border-[color:var(--border-subtle)] bg-[color:var(--surface-panel)] text-[color:var(--text-primary)]";

function ShareRunSteps({
  run,
  messages,
}: {
  run: SessionShareSnapshot["runHistory"][number];
  messages: Dictionary;
}) {
  if (!run.steps.length) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2 border-t border-[color:var(--border-subtle)] pt-3">
      {run.steps.map((entry) =>
        entry.kind === "tool" ? (
          <details
            key={entry.key}
            className="rounded-[0.75rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2"
          >
            <summary className="cursor-pointer list-none text-xs font-medium text-[color:var(--text-primary)]">
              {messages.chat.toolInvocation}: {entry.tool.name}
            </summary>
            {entry.tool.summary ? (
              <p className="mt-2 text-[11px] leading-5 text-[color:var(--text-tertiary)]">{entry.tool.summary}</p>
            ) : null}
            {entry.tool.outputPreview ? (
              <pre className="mt-2 overflow-x-auto rounded-[0.65rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-panel-strong)] px-2.5 py-2 text-[10px] leading-5 text-[color:var(--text-tertiary)]">
                {entry.tool.outputPreview}
              </pre>
            ) : null}
          </details>
        ) : (
          <div
            key={entry.key}
            className="rounded-[0.75rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-subtle)] px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="ui-badge rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]">
                {entry.phase.replace("_", " ")}
              </span>
              <span className="text-xs font-medium text-[color:var(--text-primary)]">
                {getLifecycleTitle(messages, entry.phase)}
              </span>
            </div>
            {entry.detail ? (
              <p className="mt-1 text-[11px] leading-5 text-[color:var(--text-tertiary)]">{entry.detail}</p>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}

function ShareMessageItem({
  message,
  run,
  locale,
  messages,
}: {
  message: SessionShareSnapshot["messages"][number];
  run: SessionShareSnapshot["runHistory"][number] | null;
  locale: Locale;
  messages: Dictionary;
}) {
  const isUser = message.role === "USER";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div className={`min-w-0 rounded-[0.8rem] border px-2 py-1.75 sm:px-3 sm:py-2 ${isUser ? userBubbleClassName : assistantBubbleClassName}`}>
        <MessageBody content={message.content} isUser={isUser} messages={messages} />
        {message.skills.length || message.attachments.length ? (
          <div
            className={`mt-2 flex flex-wrap gap-1.5 border-t pt-2 ${
              isUser ? "border-[rgba(17,24,39,0.12)]" : "border-[color:var(--border-subtle)]"
            }`}
          >
            {message.skills.map((skill) => (
              <SkillBadge key={skill.key} skill={skill} />
            ))}
            {message.attachments.map((attachment) => (
              <AttachmentBadge key={attachment.id} attachment={attachment} messages={messages} />
            ))}
          </div>
        ) : null}
        {run ? <ShareRunSteps run={run} messages={messages} /> : null}
        <p className={`mt-1 text-[10px] ${isUser ? "text-[color:var(--text-tertiary)]" : "text-[color:var(--text-quaternary)]"}`}>
          {formatRelativeDate(message.createdAt, locale, messages.common.noActivityYet)}
        </p>
      </div>
    </div>
  );
}

function AttachmentBadge({
  attachment,
  messages,
}: {
  attachment: SessionShareSnapshot["messages"][number]["attachments"][number];
  messages: Dictionary;
}) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-[0.9rem] border border-[color:var(--border-subtle)] bg-[color:var(--surface-muted)] px-2.5 py-1.5 text-[10px] leading-tight text-[color:var(--text-primary)] sm:px-3 sm:text-[11px]">
      <span className="max-w-full truncate font-semibold">{attachment.originalName}</span>
      <span className="text-[0.92em] text-[color:var(--text-tertiary)]">
        {attachment.mime || messages.chat.unknown} · {Math.max(1, Math.round(attachment.size / 1024))} KB
      </span>
    </span>
  );
}

function SkillBadge({
  skill,
}: {
  skill: SessionShareSnapshot["messages"][number]["skills"][number];
}) {
  return (
    <span className="ui-badge rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]">
      {skill.name}
    </span>
  );
}

function MessageBody({
  content,
  isUser,
  messages,
}: {
  content: string;
  isUser: boolean;
  messages: Dictionary;
}) {
  if (!content.trim()) {
    return null;
  }

  if (isUser) {
    return <p className="whitespace-pre-wrap text-sm leading-7">{content}</p>;
  }

  return (
    <div className="markdown-body min-w-0 max-w-full text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children, ...props }) => (
            <CodeBlock {...props} messages={messages}>
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

export function SessionShareView({
  snapshot,
  locale,
  messages,
}: {
  snapshot: SessionShareSnapshot;
  locale: Locale;
  messages: Dictionary;
}) {
  const runsInOrder = [...snapshot.runHistory].sort(
    (left, right) => new Date(left.startedAt).valueOf() - new Date(right.startedAt).valueOf(),
  );
  const assistantRunByMessageId = new Map(
    runsInOrder.filter((run) => run.assistantMessageId).map((run) => [run.assistantMessageId as string, run]),
  );

  return (
    <div className="relative min-h-[100dvh] overflow-hidden px-3 py-4 sm:px-5 sm:py-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: sharePageBackground }}
      />

      <div className="relative mx-auto flex w-full max-w-[112ch] flex-col">
        <section className="overflow-hidden rounded-[1.65rem] border border-[color:var(--border-strong)] bg-[rgba(255,255,255,0.7)] shadow-[0_30px_90px_rgba(15,23,42,0.14)] backdrop-blur-sm">
          <header className="border-b border-[color:var(--border-subtle)] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,250,252,0.9))] px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="ui-badge rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em]">
                {messages.share.eyebrow}
              </span>
            </div>
            <h1 className="mt-3 text-lg font-semibold text-[color:var(--text-primary)] sm:text-xl">{snapshot.title}</h1>
            <p className="mt-1.5 text-sm text-[color:var(--text-secondary)]">
              {messages.share.sharedAtLabel}: {formatRelativeDate(snapshot.sharedAt, locale, messages.common.noActivityYet)}
            </p>
            <p className="mt-1 text-sm text-[color:var(--text-secondary)]">{messages.share.readOnlyHint}</p>
          </header>

          <div className="border-t border-white/60 bg-[linear-gradient(180deg,rgba(249,250,251,0.96),rgba(244,246,248,0.96))] p-2.5 sm:p-3">
            <div className="flex min-h-[calc(100dvh-13rem)] w-full flex-col gap-3 sm:gap-4">
              {snapshot.messages.map((message) => {
                const run = message.role === "ASSISTANT" ? assistantRunByMessageId.get(message.id) ?? null : null;
                return (
                  <ShareMessageItem
                    key={message.id}
                    message={message}
                    run={run}
                    locale={locale}
                    messages={messages}
                  />
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
