import { OpenClawGatewayClient } from "@/lib/openclaw/gateway";

export function buildSessionKey(agentId: string, openclawSessionId: string) {
  return `agent:${agentId}:${openclawSessionId}`;
}

export function composePrompt(message: string, hostPaths: string[]) {
  if (!hostPaths.length) {
    return message;
  }

  const mediaLines = hostPaths.map((hostPath) => `MEDIA:${hostPath}`);
  return `${mediaLines.join("\n")}\n\n${message}`;
}

export async function sendToOpenClaw({
  agentId,
  openclawSessionId,
  message,
  onDelta,
  onError,
}: {
  agentId: string;
  openclawSessionId: string;
  message: string;
  onDelta?: (delta: string) => void;
  onError?: (message: string) => void;
}) {
  const client = new OpenClawGatewayClient();
  const sessionKey = buildSessionKey(agentId, openclawSessionId);

  try {
    await client.connect();
    return await client.sendMessage(sessionKey, message, { onDelta, onError });
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
