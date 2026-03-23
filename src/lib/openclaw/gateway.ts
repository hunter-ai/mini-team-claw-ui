import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getEnv } from "@/lib/env";
import {
  buildGatewayDeviceIdentity,
  persistGatewayPairingState,
  persistGatewayDeviceToken,
  resolveGatewayAuthToken,
} from "@/lib/openclaw/device-identity";

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
};

type StreamHandlers = {
  onDelta?: (delta: string) => void;
  onError?: (message: string) => void;
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

    const env = getEnv();
    const token = env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const profile = mode === "pairing-admin" ? buildPairingAdminProfile(token) : buildConnectProfile(token);

    try {
      this.ws = new WebSocket(env.OPENCLAW_GATEWAY_URL, profile.socketOptions);
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
          gatewayUrl: env.OPENCLAW_GATEWAY_URL,
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
        gatewayUrl: env.OPENCLAW_GATEWAY_URL,
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

  async sendMessage(sessionKey: string, message: string, handlers?: StreamHandlers) {
    const reqId = randomUUID();
    await this.send({
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        sessionKey,
        message,
        idempotencyKey: `msg-${randomUUID()}`,
      },
    });

    let output = "";

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

      if (!["agent", "chat"].includes(frame.event)) {
        continue;
      }

      const payload = frame.payload ?? {};
      const stream = payload.stream;
      const data = (payload.data as Record<string, unknown> | undefined) ?? {};

      if (stream === "assistant" && typeof data.delta === "string") {
        output += data.delta;
        handlers?.onDelta?.(data.delta);
      }

      if (stream === "lifecycle" && String(data.phase ?? "") === "error") {
        handlers?.onError?.(typeof data.message === "string" ? data.message : "OpenClaw stream error");
      }

      if (stream === "lifecycle" && ["end", "error"].includes(String(data.phase ?? ""))) {
        break;
      }
    }

    return { content: output } satisfies ChatResult;
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
