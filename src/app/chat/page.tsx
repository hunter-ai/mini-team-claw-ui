import { ChatShell } from "@/components/chat-shell";
import { serializeRunHistoryItem } from "@/lib/chat-run-events";
import { serializeSessionSummary } from "@/lib/chat-response";
import { toChatMessageViews } from "@/lib/chat-presenter";
import { requireUser } from "@/lib/auth";
import {
  getChatSessionForUser,
  listChatSessions,
  SESSION_PAGE_SIZE,
} from "@/lib/session-service";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const { sessions, pageInfo } = await listChatSessions(user.id, { limit: SESSION_PAGE_SIZE });
  const requestedSessionId =
    typeof query.session === "string" ? query.session : Array.isArray(query.session) ? query.session[0] : null;
  const requestedSession = requestedSessionId
    ? await getChatSessionForUser(user.id, requestedSessionId)
    : null;
  const activeSession =
    requestedSession ?? (sessions[0] ? await getChatSessionForUser(user.id, sessions[0].id) : null);
  const initialSessions = requestedSession
    ? [requestedSession, ...sessions.filter((session) => session.id !== requestedSession.id)]
    : sessions;

  return (
    <main className="h-[100dvh] w-full overflow-hidden p-1.5 sm:p-2">
      <ChatShell
        initialSessions={initialSessions.map(serializeSessionSummary)}
        initialHasMore={pageInfo.hasMore}
        initialNextCursor={pageInfo.nextCursor}
        initialActiveSessionId={activeSession?.id ?? null}
        initialMessages={activeSession ? toChatMessageViews(activeSession.messages, activeSession.attachments) : []}
        initialRunHistory={activeSession ? activeSession.runs.map((run) => serializeRunHistoryItem(run)) : []}
        initialActiveRun={activeSession?.runs[0] ? serializeSessionSummary(activeSession).activeRun : null}
        user={{
          username: user.username,
          role: user.role,
          openclawAgentId: user.openclawAgentId,
        }}
      />
    </main>
  );
}
