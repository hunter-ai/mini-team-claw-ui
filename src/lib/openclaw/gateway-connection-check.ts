import type { Dictionary } from "@/lib/i18n/dictionary";
import { OpenClawGatewayClient, OpenClawGatewayError } from "@/lib/openclaw/gateway";
import { errorFromCode, localizeError } from "@/lib/user-facing-errors";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

export type GatewayConnectionCheckResponse = {
  status: "healthy" | "pairing_required" | "auth_failed" | "unreachable" | "invalid_config";
  message?: string;
  errorCode?: string;
  errorDiagnostic?: string;
  pairing?: {
    status: "pairing_required";
    message: string;
    deviceId: string | null;
    lastPairedAt: string | null;
    pendingRequests: Array<{
      requestId: string | null;
      requestedAt: string | null;
      scopes: string[];
      clientId: string | null;
      clientMode: string | null;
      clientPlatform: string | null;
      message: string | null;
    }>;
  };
};

export async function checkGatewayConnection(messages: Dictionary): Promise<GatewayConnectionCheckResponse> {
  const client = new OpenClawGatewayClient();

  try {
    await client.connect();
    return {
      status: "healthy",
    };
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      if (error.detailCode === "PAIRING_REQUIRED") {
        const details = isObject(error.details) ? error.details : null;
        const localized = errorFromCode(messages, "gateway_pairing_required", {
          includeDiagnostic: true,
          diagnostic: error.message,
        });
        return {
          status: "pairing_required",
          message: localized.error,
          errorCode: localized.errorCode,
          errorDiagnostic: localized.errorDiagnostic,
          pairing: {
            status: "pairing_required",
            message: localized.error,
            deviceId: readString(details?.deviceId) ?? null,
            lastPairedAt: readDateIso(details?.lastPairedAt) ?? null,
            pendingRequests: error.pairingRequest ? [error.pairingRequest] : [],
          },
        };
      }

      if (
        error.detailCode === "AUTH_TOKEN_MISMATCH" ||
        error.detailCode === "AUTH_PASSWORD_MISMATCH" ||
        error.detailCode === "AUTH_PASSWORD_NOT_CONFIGURED" ||
        error.detailCode === "AUTH_DEVICE_TOKEN_MISMATCH"
      ) {
        const localized = localizeError(messages, error, {
          fallbackCode: "gateway_auth_failed",
          includeDiagnostic: true,
        });
        return {
          status: "auth_failed",
          message: localized.error,
          errorCode: localized.errorCode,
          errorDiagnostic: localized.errorDiagnostic,
        };
      }

      const localized = localizeError(messages, error, {
        fallbackCode: "gateway_unreachable",
        includeDiagnostic: true,
      });
      return {
        status: "unreachable",
        message: localized.error,
        errorCode: localized.errorCode,
        errorDiagnostic: localized.errorDiagnostic,
      };
    }

    const localized = localizeError(messages, error, {
      fallbackCode: "gateway_config_missing",
      includeDiagnostic: true,
    });
    return {
      status: "invalid_config",
      message: localized.error,
      errorCode: localized.errorCode,
      errorDiagnostic: localized.errorDiagnostic,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
