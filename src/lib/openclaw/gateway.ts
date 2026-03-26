import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  buildGatewayDeviceIdentity,
  persistGatewayPairingState,
  persistGatewayDeviceToken,
  resolveGatewayAuthToken,
} from "@/lib/openclaw/device-identity";
import { getGatewayRuntimeConfigOrThrow } from "@/lib/runtime-config";

type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type GatewayResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
};

type GatewayEvent = {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
};

export type ChatResult = {
  content: string;
  runId: string | null;
  status: string | null;
  renderMode: "markdown" | "plain_text";
};

export type GatewayToolEventStatus = "started" | "running" | "completed" | "failed";

export type GatewayToolEvent = {
  key: string;
  callId: string | null;
  name: string;
  status: GatewayToolEventStatus;
  summary: string | null;
  outputPreview: string | null;
  raw: Record<string, unknown> | null;
};

export type GatewaySkillMissing = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type GatewaySkillInstallItem = {
  id: string;
  kind: string;
  label: string;
  bins: string[];
};

export type GatewaySkillListItem = {
  key: string;
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: GatewaySkillMissing;
  install: GatewaySkillInstallItem[];
};

type GatewayChatTerminalEvent =
  | {
      type: "final";
      content: string;
      renderMode: "markdown" | "plain_text";
    }
  | {
      type: "error";
      errorMessage: string;
    };

type StreamHandlers = {
  onStarted?: (meta: { runId: string | null; status: string | null }) => void | Promise<void>;
  onDelta?: (delta: string) => void | Promise<void>;
  onToolEvent?: (event: GatewayToolEvent) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
};

type GatewayConnectProfile = {
  socketOptions: {
    origin?: string;
  };
  connectParams: {
    minProtocol: number;
    maxProtocol: number;
    client: {
      id: string;
      version: string;
      platform: string;
      mode: string;
    };
    role: "operator";
    scopes: string[];
    auth:
      | {
          token?: string;
          deviceToken?: string;
        }
      | Record<string, never>;
    locale: string;
    userAgent: string;
    caps: string[];
    device?: {
      id: string;
      publicKey: string;
      signature: string;
      signedAt: number;
      nonce: string;
    };
  };
};

type GatewayClientMode = "session" | "pairing-admin";

type PairingRequest = {
  requestId: string | null;
  requestedAt: string | null;
  scopes: string[];
  clientId: string | null;
  clientMode: string | null;
  clientPlatform: string | null;
  message: string | null;
};

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

const CONNECT_CAPS = ["agent-events", "tool-events"] as const;

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function buildConnectProfile(token: string): GatewayConnectProfile {
  return {
    socketOptions: {},
    connectParams: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        version: "0.1.0",
        platform: "node",
        mode: "backend",
      },
      role: "operator",
      scopes: [...OPERATOR_SCOPES],
      auth: token ? { token } : {},
      locale: "en-US",
      userAgent: "MiniTeamClawUI/0.1.0",
      caps: [...CONNECT_CAPS],
    },
  };
}

function buildPairingAdminProfile(token: string): GatewayConnectProfile {
  return {
    socketOptions: {},
    connectParams: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-admin-ui",
        version: "0.1.0",
        platform: "node",
        mode: "backend",
      },
      role: "operator",
      scopes: [...OPERATOR_SCOPES],
      auth: token ? { token } : {},
      locale: "en-US",
      userAgent: "MiniTeamClawUI/0.1.0",
      caps: [...CONNECT_CAPS],
    },
  };
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function firstNonEmptyStringArray(...values: unknown[]) {
  for (const value of values) {
    const next = readStringArray(value);
    if (next.length) {
      return next;
    }
  }

  return [];
}

function readDateIso(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return null;
}

function extractPairingRequest(details: Record<string, unknown> | null, fallbackMessage?: string): PairingRequest | null {
  if (!details && !fallbackMessage) {
    return null;
  }

  return {
    requestId:
      readString(details?.requestId) ??
      readString(details?.pairingRequestId) ??
      readString(details?.id) ??
      null,
    requestedAt:
      readDateIso(details?.requestedAt) ??
      readDateIso(details?.createdAt) ??
      readDateIso(details?.requested_at) ??
      null,
    scopes: firstNonEmptyStringArray(
      details?.requestedScopes,
      details?.scopes,
      details?.requested_scopes,
    ),
    clientId: readString(details?.clientId) ?? readString(details?.client_id) ?? null,
    clientMode: readString(details?.clientMode) ?? readString(details?.client_mode) ?? null,
    clientPlatform:
      readString(details?.clientPlatform) ?? readString(details?.client_platform) ?? null,
    message: fallbackMessage ?? readString(details?.message) ?? null,
  };
}

function readNestedString(
  record: Record<string, unknown> | null,
  ...keys: string[]
) {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function truncatePreview(value: string, maxLength = 240) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}...`;
}

function stringifyPreview(value: unknown, maxLength = 240) {
  if (typeof value === "string") {
    return truncatePreview(value, maxLength);
  }

  if (value === null || value === undefined) {
    return null;
  }

  try {
    return truncatePreview(JSON.stringify(value), maxLength);
  } catch {
    return truncatePreview(String(value), maxLength);
  }
}

function readNestedRecord(
  record: Record<string, unknown> | null,
  ...keys: string[]
) {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = asRecord(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function readNestedValue(
  record: Record<string, unknown> | null,
  ...keys: string[]
) {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return null;
}

function normalizeToolPhase(phase: string | null): GatewayToolEventStatus {
  const normalized = phase?.toLowerCase();
  if (!normalized) {
    return "running";
  }

  if (["start", "started", "begin", "call_start", "tool_start"].includes(normalized)) {
    return "started";
  }

  if (["end", "ended", "complete", "completed", "done", "success", "ok"].includes(normalized)) {
    return "completed";
  }

  if (["error", "failed", "failure"].includes(normalized)) {
    return "failed";
  }

  return "running";
}

function normalizeGatewayToolEvent(payload: Record<string, unknown> | undefined): GatewayToolEvent | null {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data);
  const meta = asRecord(root.meta);
  const args = readNestedRecord(root, "args") ?? readNestedRecord(data, "args") ?? readNestedRecord(meta, "args");

  const name =
    readNestedString(root, "name", "toolName", "tool_name") ??
    readNestedString(data, "name", "toolName", "tool_name") ??
    readNestedString(meta, "name", "toolName", "tool_name");

  if (!name) {
    return null;
  }

  const callId =
    readNestedString(root, "callId", "toolCallId", "tool_call_id", "id") ??
    readNestedString(data, "callId", "toolCallId", "tool_call_id", "id") ??
    readNestedString(meta, "callId", "toolCallId", "tool_call_id", "id");
  const phase =
    readNestedString(data, "phase", "status", "state") ??
    readNestedString(root, "phase", "status", "state") ??
    readNestedString(meta, "phase", "status", "state");
  const summary =
    readNestedString(data, "summary", "label", "title", "message") ??
    readNestedString(meta, "summary", "label", "title", "message") ??
    (args ? stringifyPreview(args, 160) : null);
  const outputPreview =
    stringifyPreview(readNestedValue(data, "outputPreview", "output_preview", "preview", "stdout", "stderr")) ??
    stringifyPreview(readNestedValue(root, "outputPreview", "output_preview", "preview", "stdout", "stderr")) ??
    stringifyPreview(readNestedValue(data, "output", "result", "content", "text")) ??
    stringifyPreview(readNestedValue(root, "output", "result", "content", "text"));

  return {
    key: callId ?? name,
    callId,
    name,
    status: normalizeToolPhase(phase),
    summary,
    outputPreview,
    raw: root,
  };
}

function extractTextFromMessageContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts = value
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }

      const type = readString(record.type);
      if (type === "text") {
        return readString(record.text) ?? readString(record.content);
      }

      const nestedText = readNestedString(asRecord(record.text), "value", "text");
      return nestedText ?? readString(record.content);
    })
    .filter((part): part is string => Boolean(part));

  if (!parts.length) {
    return null;
  }

  return parts.join("\n\n").trim() || null;
}

function extractChatTerminalEvent(payload: Record<string, unknown> | undefined): GatewayChatTerminalEvent | null {
  const root = asRecord(payload) ?? {};
  const state = readNestedString(root, "state", "status");
  if (!state) {
    return null;
  }

  const normalizedState = state.toLowerCase();
  if (normalizedState === "final") {
    const message = readNestedValue(root, "message", "reply", "content");
    const messageRecord = asRecord(message);
    const content =
      (typeof message === "string" ? message.trim() : null) ??
      readNestedString(messageRecord, "text", "content", "message") ??
      extractTextFromMessageContent(messageRecord?.content) ??
      readNestedString(root, "reply", "content", "message") ??
      "OpenClaw completed without returning text.";

    return {
      type: "final",
      content,
      renderMode: "plain_text",
    };
  }

  if (normalizedState === "error") {
    const message =
      readNestedString(root, "errorMessage", "error", "message") ??
      readNestedString(asRecord(root.message), "error", "message") ??
      "OpenClaw command failed";

    return {
      type: "error",
      errorMessage: message,
    };
  }

  return null;
}

function extractChatSendAck(payload: Record<string, unknown> | undefined) {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data);
  const run = asRecord(root.run) ?? asRecord(data?.run);

  return {
    runId:
      readNestedString(root, "runId", "run_id") ??
      readNestedString(data, "runId", "run_id") ??
      readNestedString(run, "id", "runId", "run_id"),
    status:
      readNestedString(root, "status") ??
      readNestedString(data, "status") ??
      readNestedString(run, "status"),
    reply:
      readNestedString(root, "reply", "content", "message") ??
      readNestedString(data, "reply", "content", "message"),
  };
}

function extractChatEventScope(payload: Record<string, unknown> | undefined) {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data);
  const meta = asRecord(root.meta);
  const run = asRecord(root.run) ?? asRecord(data?.run);
  const session = asRecord(root.session) ?? asRecord(data?.session);

  return {
    runId:
      readNestedString(root, "runId", "run_id") ??
      readNestedString(data, "runId", "run_id") ??
      readNestedString(meta, "runId", "run_id") ??
      readNestedString(run, "id", "runId", "run_id"),
    sessionKey:
      readNestedString(root, "sessionKey", "session_key", "key") ??
      readNestedString(data, "sessionKey", "session_key", "key") ??
      readNestedString(meta, "sessionKey", "session_key", "key") ??
      readNestedString(session, "key", "sessionKey", "session_key"),
  };
}

function shouldConsumeChatEvent(
  frame: GatewayEvent,
  target: {
    runId: string | null;
    sessionKey: string;
  },
) {
  if (!["agent", "chat"].includes(frame.event)) {
    return false;
  }

  const scope = extractChatEventScope(frame.payload);
  if (target.runId && scope.runId) {
    return scope.runId === target.runId;
  }

  if (!scope.runId && scope.sessionKey) {
    return scope.sessionKey === target.sessionKey;
  }

  return false;
}

function truncate(value: string, maxLength = 120) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function summarizeGatewayValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array:${value.length}]`;
    }

    return value.slice(0, 5).map((item) => summarizeGatewayValue(item, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object]";
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 12).map(([key, entryValue]) => [
        key,
        summarizeGatewayValue(entryValue, depth + 1),
      ]),
    );
  }

  return String(value);
}

function summarizeGatewayFrame(frame: GatewayEvent) {
  const payload = asRecord(frame.payload);
  const data = asRecord(payload?.data);
  const stream = readString(payload?.stream);
  const state = readString(payload?.state);
  const phase = readString(data?.phase);
  const delta = readString(data?.delta);
  const scope = extractChatEventScope(frame.payload);

  return {
    event: frame.event,
    stream,
    state,
    phase,
    scope,
    deltaLength: delta?.length ?? 0,
    deltaPreview: delta ? truncate(delta, 80) : null,
    payload: summarizeGatewayValue(frame.payload),
  };
}

function normalizeSkillInstallItem(value: unknown): GatewaySkillInstallItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const kind = readString(record.kind);
  const label = readString(record.label);

  if (!id || !kind || !label) {
    return null;
  }

  return {
    id,
    kind,
    label,
    bins: readStringArray(record.bins),
  };
}

function normalizeSkillListItem(value: unknown): GatewaySkillListItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const key = readString(record.skillKey) ?? readString(record.key);
  const name = readString(record.name);
  if (!key || !name) {
    return null;
  }

  const missing = asRecord(record.missing);
  const install = Array.isArray(record.install)
    ? record.install
        .map((item) => normalizeSkillInstallItem(item))
        .filter((item): item is GatewaySkillInstallItem => item !== null)
    : [];

  return {
    key,
    name,
    description: readString(record.description) ?? "",
    source: readString(record.source) ?? "unknown",
    bundled: readBoolean(record.bundled),
    eligible: readBoolean(record.eligible),
    disabled: readBoolean(record.disabled),
    blockedByAllowlist: readBoolean(record.blockedByAllowlist),
    missing: {
      bins: readStringArray(missing?.bins),
      anyBins: readStringArray(missing?.anyBins),
      env: readStringArray(missing?.env),
      config: readStringArray(missing?.config),
      os: readStringArray(missing?.os),
    },
    install,
  };
}

function logGatewayDebug(message: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug(message, details);
}

export class OpenClawGatewayError extends Error {
  code: string | null;
  detailCode: string | null;
  details: Record<string, unknown> | null;
  pairingRequest: PairingRequest | null;

  constructor({
    message,
    code,
    detailCode,
    details,
  }: {
    message: string;
    code: string | null;
    detailCode: string | null;
    details: Record<string, unknown> | null;
  }) {
    super(message);
    this.name = "OpenClawGatewayError";
    this.code = code;
    this.detailCode = detailCode;
    this.details = details;
    this.pairingRequest = detailCode === "PAIRING_REQUIRED" ? extractPairingRequest(details, message) : null;
  }
}

export class OpenClawGatewayClient {
  private ws?: WebSocket;
  private frameQueue: Array<GatewayResponse | GatewayEvent> = [];
  private pendingReceivers: Array<{
    resolve: (frame: GatewayResponse | GatewayEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  private socketError: Error | null = null;

  async connect(mode: GatewayClientMode = "session") {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const runtimeConfig = await getGatewayRuntimeConfigOrThrow();
    const token = runtimeConfig.gatewayToken ?? "";
    const profile = mode === "pairing-admin" ? buildPairingAdminProfile(token) : buildConnectProfile(token);

    try {
      this.ws = new WebSocket(runtimeConfig.gatewayUrl, profile.socketOptions);
      this.attachSocketListeners();
      await new Promise<void>((resolve, reject) => {
        this.ws?.once("open", () => resolve());
        this.ws?.once("error", reject);
      });

      const challenge = await this.waitForGatewayEvent("connect.challenge");
      const nonce =
        typeof challenge.payload?.nonce === "string" ? challenge.payload.nonce.trim() : "";
      if (!nonce) {
        throw new Error("[openclaw] connect failed: gateway did not provide a connect.challenge nonce");
      }

      const authState = await resolveGatewayAuthToken(token);
      const device =
        mode === "pairing-admin"
          ? undefined
          : await (async () => {
              if (!authState.tokenForSignature) {
                throw new Error(
                  "[openclaw] connect failed: no gateway auth token is available for device authentication",
                );
              }

              return buildGatewayDeviceIdentity({
                clientId: profile.connectParams.client.id,
                clientMode: profile.connectParams.client.mode,
                role: profile.connectParams.role,
                scopes: profile.connectParams.scopes,
                token: authState.tokenForSignature,
                nonce,
              });
            })();

      const response = await this.request("connect", {
        ...profile.connectParams,
        auth: authState.auth,
        ...(device ? { device } : {}),
      });

      if (!response.ok) {
        const detailCode =
          typeof response.error?.details?.code === "string"
            ? response.error.details.code
            : null;
        const detailsRecord = asRecord(response.error?.details);
        const details = {
          code: response.error?.code ?? null,
          detailCode,
          message: response.error?.message ?? "OpenClaw connect failed",
          gatewayUrl: runtimeConfig.gatewayUrl,
          hasToken: Boolean(token),
          client: profile.connectParams.client,
          scopes: profile.connectParams.scopes,
        };
        console.error("[openclaw] connect rejected", details);
        if (detailCode === "PAIRING_REQUIRED" && mode === "session") {
          const pairingRequest = extractPairingRequest(detailsRecord, response.error?.message);
          await persistGatewayPairingState({
            status: "pairing_required",
            message: response.error?.message ?? "Device pairing required",
            requestId: pairingRequest?.requestId ?? null,
            requestedAt: pairingRequest?.requestedAt ? new Date(pairingRequest.requestedAt) : new Date(),
            requestedScopes: pairingRequest?.scopes ?? profile.connectParams.scopes,
            clientId: pairingRequest?.clientId ?? profile.connectParams.client.id,
            clientMode: pairingRequest?.clientMode ?? profile.connectParams.client.mode,
            clientPlatform: pairingRequest?.clientPlatform ?? profile.connectParams.client.platform,
          });
        } else if (mode === "session") {
          await persistGatewayPairingState({
            status: "failed",
            message: response.error?.message ?? "OpenClaw connect failed",
            requestedScopes: profile.connectParams.scopes,
            clientId: profile.connectParams.client.id,
            clientMode: profile.connectParams.client.mode,
            clientPlatform: profile.connectParams.client.platform,
          });
        }
        throw new OpenClawGatewayError({
          message: this.formatConnectError(details),
          code: response.error?.code ?? null,
          detailCode,
          details: detailsRecord,
        });
      }

      await persistGatewayDeviceToken(
        ((response.payload?.auth as Record<string, unknown> | undefined) ?? undefined) as
          | { deviceToken?: string; scopes?: unknown }
          | undefined,
      );
      if (mode === "session") {
        await persistGatewayPairingState({ status: "healthy", message: null });
      }
    } catch (error) {
      console.error("[openclaw] connect failed", {
        gatewayUrl: runtimeConfig.gatewayUrl,
        hasToken: Boolean(token),
        error: summarizeError(error),
      });
      throw error;
    }
  }

  async close() {
    if (!this.ws) {
      return;
    }

    const ws = this.ws;

    if (ws.readyState === WebSocket.CLOSED) {
      this.ws = undefined;
      this.frameQueue = [];
      this.pendingReceivers = [];
      this.socketError = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timer = setTimeout(() => {
        ws.removeAllListeners("close");
        ws.terminate();
        finish();
      }, 1000);

      ws.once("close", () => {
        clearTimeout(timer);
        finish();
      });

      if (ws.readyState === WebSocket.CLOSING) {
        return;
      }

      ws.close();
    });
    this.ws = undefined;
    this.frameQueue = [];
    this.pendingReceivers = [];
    this.socketError = null;
  }

  async abortSession(sessionKey: string) {
    const response = await this.request("chat.abort", { sessionKey });
    if (!response.ok) {
      const message = response.error?.message ?? "Failed to abort session";
      console.error("[openclaw] chat.abort failed", {
        sessionKey,
        code: response.error?.code ?? null,
        message,
      });
      throw new Error(message);
    }
  }

  async sendMessage(
    sessionKey: string,
    message: string,
    handlers?: StreamHandlers,
    options?: { idempotencyKey?: string },
  ) {
    const reqId = randomUUID();
    const idempotencyKey = options?.idempotencyKey ?? `msg-${randomUUID()}`;
    await this.send({
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey,
        message,
        idempotencyKey,
      },
    });

    let output = "";
    let runId: string | null = null;
    let status: string | null = null;
    let renderMode: ChatResult["renderMode"] = "markdown";
    let ignoredEventCount = 0;
    let acceptedEventCount = 0;
    const bufferedEvents: GatewayEvent[] = [];

    logGatewayDebug("[chat-debug][gateway] sent chat.send", {
      reqId,
      sessionKey,
      idempotencyKey,
      messageLength: message.length,
    });

    while (true) {
      const frame = await this.receive();
      if (frame.type === "res" && frame.id === reqId) {
        if (!frame.ok) {
          const message = frame.error?.message ?? "chat.send failed";
          const detailCode =
            typeof frame.error?.details?.code === "string" ? frame.error.details.code : null;
          console.error("[openclaw] chat.send failed", {
            sessionKey,
            code: frame.error?.code ?? null,
            detailCode,
            message,
          });
          throw new Error(this.formatRequestError("chat.send", message, detailCode));
        }

        const ack = extractChatSendAck(frame.payload);
        runId = ack.runId;
        status = ack.status;
        logGatewayDebug("[chat-debug][gateway] received chat.send ack", {
          sessionKey,
          reqId,
          idempotencyKey,
          runId,
          status,
          replyLength: ack.reply?.length ?? 0,
          payload: summarizeGatewayValue(frame.payload),
        });
        await handlers?.onStarted?.({ runId, status });

        if (status === "ok" && ack.reply) {
          output = ack.reply;
          return {
            content: output,
            runId,
            status,
            renderMode: "markdown",
          } satisfies ChatResult;
        }

        break;
      }

      if (frame.type === "event") {
        bufferedEvents.push(frame);
      }
    }

    if (bufferedEvents.length > 0) {
      logGatewayDebug("[chat-debug][gateway] buffered pre-ack events", {
        reqId,
        sessionKey,
        idempotencyKey,
        bufferedEventCount: bufferedEvents.length,
        sample: bufferedEvents.slice(0, 3).map((frame) => summarizeGatewayFrame(frame)),
      });
    }

    const consumeEvent = async (frame: GatewayEvent) => {
      const matches = shouldConsumeChatEvent(frame, { runId, sessionKey });
      const summary = summarizeGatewayFrame(frame);

      if (!matches) {
        ignoredEventCount += 1;
        if (ignoredEventCount <= 5 || ignoredEventCount % 25 === 0) {
          logGatewayDebug("[chat-debug][gateway] ignored event", {
            reqId,
            sessionKey,
            idempotencyKey,
            runId,
            ignoredEventCount,
            event: summary,
          });
        }
        return false;
      }

      acceptedEventCount += 1;
      if (acceptedEventCount <= 5 || summary.stream === "lifecycle" || acceptedEventCount % 25 === 0) {
        logGatewayDebug("[chat-debug][gateway] accepted event", {
          reqId,
          sessionKey,
          idempotencyKey,
          runId,
          acceptedEventCount,
          event: summary,
        });
      }

      const payload = frame.payload ?? {};
      const stream = payload.stream;
      const data = (payload.data as Record<string, unknown> | undefined) ?? {};
      const chatTerminalEvent = frame.event === "chat" ? extractChatTerminalEvent(payload) : null;

      if (chatTerminalEvent?.type === "final") {
        output = chatTerminalEvent.content;
        status = "ok";
        renderMode = chatTerminalEvent.renderMode;
        return true;
      }

      if (chatTerminalEvent?.type === "error") {
        status = "error";
        await handlers?.onError?.(chatTerminalEvent.errorMessage);
        throw new Error(chatTerminalEvent.errorMessage);
      }

      if (stream === "assistant" && typeof data.delta === "string") {
        output += data.delta;
        await handlers?.onDelta?.(data.delta);
      }

      if (stream === "tool") {
        const toolEvent = normalizeGatewayToolEvent(payload);
        if (toolEvent) {
          await handlers?.onToolEvent?.(toolEvent);
        }
      }

      if (stream === "lifecycle" && String(data.phase ?? "") === "error") {
        status = "error";
        await handlers?.onError?.(
          typeof data.message === "string" ? data.message : "OpenClaw stream error",
        );
      }

      if (stream === "lifecycle" && ["end", "error"].includes(String(data.phase ?? ""))) {
        status = String(data.phase ?? status ?? "ok");
        return true;
      }

      return false;
    };

    for (const frame of bufferedEvents) {
      const done = await consumeEvent(frame);
      if (done) {
        logGatewayDebug("[chat-debug][gateway] stream complete from buffered event", {
          sessionKey,
          reqId,
          idempotencyKey,
          runId,
          status,
          acceptedEventCount,
          ignoredEventCount,
          outputLength: output.length,
        });
        return {
          content: output,
          runId,
          status,
          renderMode,
        } satisfies ChatResult;
      }
    }

    while (true) {
      const frame = await this.receive();
      if (frame.type === "res" && frame.id === reqId && !frame.ok) {
        const message = frame.error?.message ?? "chat.send failed";
        const detailCode =
          typeof frame.error?.details?.code === "string" ? frame.error.details.code : null;
        console.error("[openclaw] chat.send failed", {
          sessionKey,
          code: frame.error?.code ?? null,
          detailCode,
          message,
        });
        throw new Error(this.formatRequestError("chat.send", message, detailCode));
      }

      if (frame.type !== "event") {
        continue;
      }

      if (await consumeEvent(frame)) {
        break;
      }
    }

    logGatewayDebug("[chat-debug][gateway] stream complete", {
      sessionKey,
      reqId,
      idempotencyKey,
      runId,
      status,
      acceptedEventCount,
      ignoredEventCount,
      outputLength: output.length,
    });

    return { content: output, runId, status, renderMode } satisfies ChatResult;
  }

  async listPairingRequests() {
    const response = await this.request("devices.list", {});
    if (!response.ok) {
      const detailCode =
        typeof response.error?.details?.code === "string" ? response.error.details.code : null;
      throw new OpenClawGatewayError({
        message: this.formatRequestError("devices.list", response.error?.message ?? "devices.list failed", detailCode),
        code: response.error?.code ?? null,
        detailCode,
        details: asRecord(response.error?.details),
      });
    }

    const payload = asRecord(response.payload) ?? {};
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.requests)
        ? payload.requests
        : [];

    return items
      .map((item) => extractPairingRequest(asRecord(item)))
      .filter((item): item is PairingRequest => item !== null);
  }

  async approvePairingRequest(requestId: string) {
    const response = await this.request("devices.approve", { requestId });
    if (!response.ok) {
      const detailCode =
        typeof response.error?.details?.code === "string" ? response.error.details.code : null;
      throw new OpenClawGatewayError({
        message: this.formatRequestError(
          "devices.approve",
          response.error?.message ?? "devices.approve failed",
          detailCode,
        ),
        code: response.error?.code ?? null,
        detailCode,
        details: asRecord(response.error?.details),
      });
    }
  }

  async listSkills() {
    const response = await this.request("skills.status", {});
    if (!response.ok) {
      const detailCode =
        typeof response.error?.details?.code === "string" ? response.error.details.code : null;
      throw new OpenClawGatewayError({
        message: this.formatRequestError(
          "skills.status",
          response.error?.message ?? "skills.status failed",
          detailCode,
        ),
        code: response.error?.code ?? null,
        detailCode,
        details: asRecord(response.error?.details),
      });
    }

    const payload = asRecord(response.payload) ?? {};
    const items = Array.isArray(payload.skills)
      ? payload.skills
      : Array.isArray(payload.items)
        ? payload.items
        : [];

    return items
      .map((item) => normalizeSkillListItem(item))
      .filter((item): item is GatewaySkillListItem => item !== null);
  }

  private async request(method: string, params: Record<string, unknown>) {
    const reqId = randomUUID();
    await this.send({ type: "req", id: reqId, method, params });

    while (true) {
      const frame = await this.receive();
      if (frame.type === "res" && frame.id === reqId) {
        return frame;
      }
    }
  }

  private async waitForGatewayEvent(name: string) {
    while (true) {
      const frame = await this.receive();
      if (frame.type === "event" && frame.event === name) {
        return frame;
      }
    }
  }

  private async receive() {
    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }

    if (this.frameQueue.length) {
      return this.frameQueue.shift()!;
    }

    if (this.socketError) {
      throw this.socketError;
    }

    return await new Promise<GatewayResponse | GatewayEvent>((resolve, reject) => {
      this.pendingReceivers.push({ resolve, reject });
    });
  }

  private attachSocketListeners() {
    if (!this.ws) {
      return;
    }

    this.ws.on("message", (value) => {
      try {
        const frame = JSON.parse(String(value)) as GatewayResponse | GatewayEvent;
        const receiver = this.pendingReceivers.shift();
        if (receiver) {
          receiver.resolve(frame);
          return;
        }

        this.frameQueue.push(frame);
      } catch (error) {
        this.rejectPendingReceivers(
          error instanceof Error ? error : new Error(`Invalid gateway frame: ${String(value)}`),
        );
      }
    });

    this.ws.on("error", (error) => {
      const nextError = error instanceof Error ? error : new Error(String(error));
      this.socketError = nextError;
      this.rejectPendingReceivers(nextError);
    });

    this.ws.on("close", () => {
      const nextError = this.socketError ?? new Error("Gateway connection closed");
      this.socketError = nextError;
      this.rejectPendingReceivers(nextError);
    });
  }

  private rejectPendingReceivers(error: Error) {
    while (this.pendingReceivers.length) {
      const receiver = this.pendingReceivers.shift();
      receiver?.reject(error);
    }
  }

  private async send(frame: ReqFrame) {
    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }

    await new Promise<void>((resolve, reject) => {
      this.ws?.send(JSON.stringify(frame), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private formatConnectError(details: {
    code: string | null;
    detailCode: string | null;
    message: string;
    client: {
      id: string;
      mode: string;
      platform: string;
    };
    scopes: string[];
  }) {
    const identity = `${details.client.id}/${details.client.mode}/${details.client.platform}`;
    const scopeList = details.scopes.join(",");
    const suffix = `(client=${identity}, scopes=${scopeList})`;

    if (details.detailCode === "PAIRING_REQUIRED") {
      return `[openclaw] connect rejected: device pairing required. Approve this device with \`openclaw devices list\` and \`openclaw devices approve <requestId>\` ${suffix}`;
    }

    if (details.detailCode === "AUTH_DEVICE_TOKEN_MISMATCH") {
      return `[openclaw] connect rejected: cached device token is stale or revoked. Re-approve or rotate the device token, then reconnect ${suffix}`;
    }

    if (details.detailCode === "AUTH_TOKEN_MISMATCH") {
      return `[openclaw] connect rejected: gateway auth token mismatch. Check OPENCLAW_GATEWAY_TOKEN against the gateway configuration ${suffix}`;
    }

    return `[openclaw] connect rejected: ${details.message} ${suffix}`;
  }

  private formatRequestError(method: string, message: string, detailCode: string | null) {
    if (detailCode === "PAIRING_REQUIRED") {
      return `[openclaw] ${method} failed: device pairing is still required`;
    }

    if (message.includes("missing scope: operator.write")) {
      return "[openclaw] chat.send failed: this connection does not have operator.write. The gateway device is not paired or its device token was not granted write scope";
    }

    return `[openclaw] ${method} failed: ${message}`;
  }
}
