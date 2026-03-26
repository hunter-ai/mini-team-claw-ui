import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";
import { getStartupEnvDiagnostics } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";
import { localizeHref } from "@/lib/i18n/routing";
import { prisma } from "@/lib/prisma";
import { getResolvedRuntimeConfig } from "@/lib/runtime-config";

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
  hasActiveAdmin: boolean;
  hasRuntimeConfig: boolean;
  configSource: SetupConfigSource;
  runtimeConfig: {
    gatewayUrl: string;
    gatewayTokenConfigured: boolean;
    appUrl: string | null;
  } | null;
  gatewayStatus: SetupGatewayStatus;
  pairing: SetupPairingState;
  envDiagnostics: ReturnType<typeof getStartupEnvDiagnostics>;
};

export async function getSetupStatus(): Promise<SetupStatus> {
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
            gatewayIdentity.lastPairingMessage?.includes("stale or revoked")
            ? ("auth_failed" as SetupGatewayStatus)
            : ("unreachable" as SetupGatewayStatus)
          : ("untested" as SetupGatewayStatus);

  const hasRuntimeConfig = Boolean(runtimeConfig?.gatewayUrl && runtimeConfig.gatewayTokenConfigured);

  return {
    isComplete: activeAdminCount > 0 && hasRuntimeConfig && gatewayStatus === "healthy",
    hasActiveAdmin: activeAdminCount > 0,
    hasRuntimeConfig,
    configSource: (runtimeConfig?.source ?? "missing") as SetupConfigSource,
    runtimeConfig: runtimeConfig
      ? {
          gatewayUrl: runtimeConfig.gatewayUrl,
          gatewayTokenConfigured: runtimeConfig.gatewayTokenConfigured,
          appUrl: runtimeConfig.appUrl,
        }
      : null,
    gatewayStatus,
    pairing,
    envDiagnostics: getStartupEnvDiagnostics(),
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
