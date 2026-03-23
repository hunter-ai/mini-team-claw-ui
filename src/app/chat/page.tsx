import { ChatShell } from "@/components/chat-shell";
import { requireUser } from "@/lib/auth";
import {
  getChatSessionForUser,
  listChatSessions,
  SESSION_PAGE_SIZE,
} from "@/lib/session-service";

export default async function ChatPage() {
  const user = await requireUser();
  const { sessions, pageInfo } = await listChatSessions(user.id, { limit: SESSION_PAGE_SIZE });
  const firstSession = sessions[0] ? await getChatSessionForUser(user.id, sessions[0].id) : null;

  return (
    <main className="h-[100dvh] w-full overflow-hidden p-1.5 sm:p-2">
      <ChatShell
        initialSessions={sessions.map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt.toISOString(),
          lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
        }))}
        initialHasMore={pageInfo.hasMore}
        initialNextCursor={pageInfo.nextCursor}
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
    </main>
  );
}
