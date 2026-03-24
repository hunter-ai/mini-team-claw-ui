import { ChatPage } from "@/app/_shared/chat-page";

export default async function EnglishChatPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  return ChatPage({ locale: "en", searchParams });
}
