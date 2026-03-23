import Link from "next/link";
import { ChatShell } from "@/components/chat-shell";
import { LogoutButton } from "@/components/logout-button";
import { requireUser } from "@/lib/auth";
import { getChatSessionForUser, listChatSessions } from "@/lib/session-service";

export default async function ChatPage() {
  const user = await requireUser();
  const sessions = await listChatSessions(user.id);
  const firstSession = sessions[0] ? await getChatSessionForUser(user.id, sessions[0].id) : null;

  return (
    <main className="mx-auto flex h-[100dvh] w-full max-w-7xl flex-col overflow-hidden px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-4 flex shrink-0 flex-col gap-4 rounded-[2rem] border border-white/10 bg-black/20 px-5 py-5 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-amber-300/70">OpenClaw team UI</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Sessions stay scoped to the current member.</h1>
        </div>
        <div className="flex items-center gap-3">
          {user.role === "ADMIN" ? (
            <Link
              href="/admin"
              className="rounded-full border border-white/20 px-3 py-2 text-sm font-medium text-stone-100 transition hover:border-amber-400/80 hover:text-amber-200"
            >
              Admin
            </Link>
          ) : null}
          <LogoutButton />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatShell
          initialSessions={sessions.map((session) => ({
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt.toISOString(),
            lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
          }))}
          initialActiveSessionId={sessions[0]?.id ?? null}
          initialMessages={
            firstSession?.messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              createdAt: message.createdAt.toISOString(),
            })) ?? []
          }
          initialAttachments={
            firstSession?.attachments.map((attachment) => ({
              id: attachment.id,
              originalName: attachment.originalName,
              mime: attachment.mime,
              size: attachment.size,
            })) ?? []
          }
          user={{
            username: user.username,
            role: user.role,
            openclawAgentId: user.openclawAgentId,
          }}
        />
      </div>
    </main>
  );
}
