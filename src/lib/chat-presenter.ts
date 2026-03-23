import { Attachment, ChatMessageCache, MessageRole } from "@prisma/client";

export type AttachmentSummary = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
};

export type ChatMessageView = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachments: AttachmentSummary[];
};

export function toAttachmentSummary(attachment: Pick<Attachment, "id" | "originalName" | "mime" | "size">): AttachmentSummary {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mime: attachment.mime,
    size: attachment.size,
  };
}

export function toChatMessageViews(
  messages: Pick<ChatMessageCache, "id" | "role" | "content" | "createdAt" | "attachmentIds">[],
  attachments: Pick<Attachment, "id" | "originalName" | "mime" | "size">[],
): ChatMessageView[] {
  const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, toAttachmentSummary(attachment)]));

  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachmentIds
      .map((attachmentId) => attachmentMap.get(attachmentId))
      .filter((attachment): attachment is AttachmentSummary => Boolean(attachment)),
  }));
}
