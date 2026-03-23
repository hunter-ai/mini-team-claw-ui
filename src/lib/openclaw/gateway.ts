import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getEnv } from "@/lib/env";
import {
  buildGatewayDeviceIdentity,
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

export class OpenClawGatewayClient {
  private ws?: WebSocket;

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const env = getEnv();
    const token = env.OPENCLAW_GATEWAY_TOKEN ?? "";
    const profile = buildConnectProfile(token);

    try {
      this.ws = new WebSocket(env.OPENCLAW_GATEWAY_URL, profile.socketOptions);
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
      if (!authState.tokenForSignature) {
        throw new Error(
          "[openclaw] connect failed: no gateway auth token is available for device authentication",
        );
      }

      const device = await buildGatewayDeviceIdentity({
        clientId: profile.connectParams.client.id,
        clientMode: profile.connectParams.client.mode,
        role: profile.connectParams.role,
        scopes: profile.connectParams.scopes,
        token: authState.tokenForSignature,
        nonce,
      });

      const response = await this.request("connect", {
        ...profile.connectParams,
        auth: authState.auth,
        device,
      });

      if (!response.ok) {
        const detailCode =
          typeof response.error?.details?.code === "string"
            ? response.error.details.code
            : null;
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
        throw new Error(this.formatConnectError(details));
      }

      await persistGatewayDeviceToken(
        ((response.payload?.auth as Record<string, unknown> | undefined) ?? undefined) as
          | { deviceToken?: string; scopes?: unknown }
          | undefined,
      );
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

    await new Promise<void>((resolve) => {
      this.ws?.once("close", () => resolve());
      this.ws?.close();
    });
    this.ws = undefined;
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

    const data = await new Promise<string>((resolve, reject) => {
      const handleMessage = (value: WebSocket.RawData) => {
        cleanup();
        resolve(String(value));
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.ws?.off("message", handleMessage);
        this.ws?.off("error", handleError);
      };

      this.ws?.on("message", handleMessage);
      this.ws?.on("error", handleError);
    });

    return JSON.parse(data) as GatewayResponse | GatewayEvent;
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
