import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";
import { getStartupEnv, getStartupEnvDiagnostics } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";
import { prisma } from "@/lib/prisma";
import { getResolvedRuntimeConfig } from "@/lib/runtime-config";
import type { GatewayRemediation } from "@/lib/openclaw/gateway-remediation";
import { inferGatewayRemediation } from "@/lib/openclaw/gateway-remediation";
import { localizePersistedGatewayMessage } from "@/lib/user-facing-errors";

export type SetupGatewayStatus =
  | "untested"
  | "healthy"
  | "pairing_required"
  | "auth_failed"
  | "unreachable"
  | "invalid_config";

export type SetupConfigSource = "db" | "env-fallback" | "missing";

export type SetupPairingState = {
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
  } | null;

export type SetupStatus = {
  isComplete: boolean;
  adminBootstrapMode: "seed" | "ui";
  hasActiveAdmin: boolean;
  hasRuntimeConfig: boolean;
  configSource: SetupConfigSource;
  runtimeConfig: {
    gatewayUrl: string;
    gatewayAuthMode: "token" | "password";
    gatewayTokenConfigured: boolean;
    gatewayPasswordConfigured: boolean;
    gatewayCredentialConfigured: boolean;
    appUrl: string | null;
  } | null;
  gatewayStatus: SetupGatewayStatus;
  gatewayRemediation: GatewayRemediation;
  pairing: SetupPairingState;
  envDiagnostics: ReturnType<typeof getStartupEnvDiagnostics>;
};

export async function getSetupStatus(): Promise<SetupStatus> {
  const env = getStartupEnv();
  const [activeAdminCount, runtimeConfig, gatewayIdentity] = await Promise.all([
    prisma.user.count({
      where: {
        role: UserRole.ADMIN,
        isActive: true,
      },
    }),
    getResolvedRuntimeConfig(),
    prisma.gatewayOperatorIdentity.findUnique({
      where: { id: "default" },
      select: {
        deviceId: true,
        lastPairedAt: true,
        lastPairingStatus: true,
        lastPairingMessage: true,
        lastPairingRequestId: true,
        lastPairingRequestedAt: true,
        lastRequestedScopes: true,
        lastPairingClientId: true,
        lastPairingClientMode: true,
        lastPairingClientPlatform: true,
      },
    }),
  ]);

  const pairing =
    gatewayIdentity?.lastPairingStatus === "pairing_required"
      ? {
          status: "pairing_required" as const,
          message: gatewayIdentity.lastPairingMessage ?? "Device pairing required",
          deviceId: gatewayIdentity.deviceId,
          lastPairedAt: gatewayIdentity.lastPairedAt?.toISOString() ?? null,
          pendingRequests: [
            {
              requestId: gatewayIdentity.lastPairingRequestId,
              requestedAt: gatewayIdentity.lastPairingRequestedAt?.toISOString() ?? null,
              scopes: gatewayIdentity.lastRequestedScopes,
              clientId: gatewayIdentity.lastPairingClientId,
              clientMode: gatewayIdentity.lastPairingClientMode,
              clientPlatform: gatewayIdentity.lastPairingClientPlatform,
              message: gatewayIdentity.lastPairingMessage,
            },
          ].filter((item) => item.requestId || item.message),
        }
      : null;

  const gatewayStatus =
    gatewayIdentity?.lastPairingStatus === "healthy"
      ? ("healthy" as SetupGatewayStatus)
      : gatewayIdentity?.lastPairingStatus === "pairing_required"
        ? ("pairing_required" as SetupGatewayStatus)
        : gatewayIdentity?.lastPairingStatus === "failed"
          ? gatewayIdentity.lastPairingMessage?.includes("token mismatch") ||
            gatewayIdentity.lastPairingMessage?.includes("password mismatch") ||
            gatewayIdentity.lastPairingMessage?.includes("stale or revoked")
            ? ("auth_failed" as SetupGatewayStatus)
            : ("unreachable" as SetupGatewayStatus)
        : ("untested" as SetupGatewayStatus);
  const gatewayRemediation = inferGatewayRemediation(
    gatewayIdentity?.lastPairingStatus,
    gatewayIdentity?.lastPairingMessage,
  );

  const hasRuntimeConfig = Boolean(runtimeConfig?.gatewayUrl && runtimeConfig.gatewayCredentialConfigured);

  return {
    isComplete: activeAdminCount > 0 && hasRuntimeConfig && gatewayStatus === "healthy",
    adminBootstrapMode: env.ADMIN_BOOTSTRAP_MODE,
    hasActiveAdmin: activeAdminCount > 0,
    hasRuntimeConfig,
    configSource: (runtimeConfig?.source ?? "missing") as SetupConfigSource,
    runtimeConfig: runtimeConfig
      ? {
          gatewayUrl: runtimeConfig.gatewayUrl,
          gatewayAuthMode: runtimeConfig.gatewayAuthMode,
          gatewayTokenConfigured: runtimeConfig.gatewayTokenConfigured,
          gatewayPasswordConfigured: runtimeConfig.gatewayPasswordConfigured,
          gatewayCredentialConfigured: runtimeConfig.gatewayCredentialConfigured,
          appUrl: runtimeConfig.appUrl,
        }
      : null,
    gatewayStatus,
    gatewayRemediation,
    pairing,
    envDiagnostics: getStartupEnvDiagnostics(),
  };
}

export function localizeSetupStatus(status: SetupStatus, messages: Dictionary): SetupStatus {
  if (!status.pairing) {
    return status;
  }

  const pairing = status.pairing;

  return {
    ...status,
    pairing: {
      ...pairing,
      message:
        localizePersistedGatewayMessage(messages, pairing.status, pairing.message) ??
        pairing.message,
      pendingRequests: pairing.pendingRequests.map((request) => ({
        ...request,
        message:
          localizePersistedGatewayMessage(messages, pairing.status, request.message) ??
          request.message,
      })),
    },
  };
}

export async function redirectToSetupIfNeeded(locale: Locale) {
  const status = await getSetupStatus();
  if (!status.isComplete) {
    redirect(localizeHref(locale, "/setup"));
  }

  return status;
}

export async function redirectAwayFromSetupWhenComplete(locale: Locale) {
  const status = await getSetupStatus();
  if (!status.isComplete) {
    return status;
  }

  const user = await getCurrentUser();
  if (user?.role === UserRole.ADMIN) {
    redirect(localizeHref(locale, "/admin"));
  }

  if (user) {
    redirect(localizeHref(locale, "/chat"));
  }

  redirect(localizeHref(locale, "/login"));
}
