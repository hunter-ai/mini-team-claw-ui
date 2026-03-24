import { ChatPage } from "@/app/_shared/chat-page";

export default async function ChineseChatPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  return ChatPage({ locale: "zh", searchParams });
}
