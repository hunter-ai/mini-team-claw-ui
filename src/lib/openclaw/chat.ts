import { OpenClawGatewayClient } from "@/lib/openclaw/gateway";
import type { GatewayToolEvent } from "@/lib/openclaw/gateway";

type OpenClawAttachmentInput = {
  id: string;
  hostPath: string;
};

type OpenClawSelectedSkillInput = {
  key: string;
};

export type OpenClawChatInput = {
  message: string;
  mode: "media_prompt";
  attachmentIds: string[];
};

export function buildSessionKey(agentId: string, openclawSessionId: string) {
  return `agent:${agentId}:${openclawSessionId}`;
}

export function composePrompt(message: string, hostPaths: string[], skillKeys: string[] = []) {
  return buildOpenClawInput({
    text: message,
    attachments: hostPaths.map((hostPath, index) => ({
      id: String(index),
      hostPath,
    })),
    selectedSkills: skillKeys.map((key) => ({ key })),
  }).message;
}

export function buildOpenClawInput({
  text,
  attachments,
  selectedSkills,
}: {
  text: string;
  attachments: OpenClawAttachmentInput[];
  selectedSkills: OpenClawSelectedSkillInput[];
}): OpenClawChatInput {
  const skillLines = selectedSkills.map((skill) => `[@skill:${skill.key}]`);

  if (!attachments.length && !skillLines.length) {
    return {
      message: text,
      mode: "media_prompt",
      attachmentIds: [],
    };
  }

  const mediaLines = attachments.map((attachment) => `MEDIA:${attachment.hostPath}`);
  const promptSections = [
    mediaLines.length ? mediaLines.join("\n") : null,
    skillLines.length ? skillLines.join("\n") : null,
    text || null,
  ].filter((value): value is string => Boolean(value));
  const prompt = promptSections.join("\n\n");

  return {
    message: prompt,
    mode: "media_prompt",
    attachmentIds: attachments.map((attachment) => attachment.id),
  };
}

export async function sendToOpenClaw({
  agentId,
  openclawSessionId,
  message,
  idempotencyKey,
  onStarted,
  onDelta,
  onToolEvent,
  onError,
}: {
  agentId: string;
  openclawSessionId: string;
  message: string;
  idempotencyKey?: string;
  onStarted?: (meta: { runId: string | null; status: string | null }) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  onToolEvent?: (event: GatewayToolEvent) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
}) {
  const client = new OpenClawGatewayClient();
  const sessionKey = buildSessionKey(agentId, openclawSessionId);

  try {
    await client.connect();
    return await client.sendMessage(
      sessionKey,
      message,
      { onStarted, onDelta, onToolEvent, onError },
      { idempotencyKey },
    );
  } finally {
    await client.close();
  }
}

export async function abortOpenClawSession(agentId: string, openclawSessionId: string) {
  const client = new OpenClawGatewayClient();
  const sessionKey = buildSessionKey(agentId, openclawSessionId);

  try {
    await client.connect();
    await client.abortSession(sessionKey);
  } finally {
    await client.close();
  }
}
