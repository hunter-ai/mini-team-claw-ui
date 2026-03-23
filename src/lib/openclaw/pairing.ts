import { getStoredGatewayIdentity, persistGatewayPairingState } from "@/lib/openclaw/device-identity";
import { OpenClawGatewayClient, OpenClawGatewayError } from "@/lib/openclaw/gateway";

export type PairingStatus = "healthy" | "pairing_required" | "approving" | "failed";

export type PendingPairingRequest = {
  requestId: string | null;
  requestedAt: string | null;
  scopes: string[];
  clientId: string | null;
  clientMode: string | null;
  clientPlatform: string | null;
  message: string | null;
};

export type GatewayPairingSummary = {
  status: PairingStatus;
  message: string | null;
  deviceId: string;
  lastPairedAt: string | null;
  tokenScopes: string[];
  pendingRequests: PendingPairingRequest[];
};

function buildSummary(args: {
  identity: Awaited<ReturnType<typeof getStoredGatewayIdentity>>;
  status?: PairingStatus;
  message?: string | null;
  pendingRequests?: PendingPairingRequest[];
}): GatewayPairingSummary {
  const fallbackPending =
    args.identity.lastPairingStatus === "pairing_required" || args.identity.lastPairingStatus === "approving"
      ? [
          {
            requestId: args.identity.lastPairingRequestId,
            requestedAt: args.identity.lastPairingRequestedAt?.toISOString() ?? null,
            scopes: args.identity.lastRequestedScopes,
            clientId: args.identity.lastPairingClientId,
            clientMode: args.identity.lastPairingClientMode,
            clientPlatform: args.identity.lastPairingClientPlatform,
            message: args.identity.lastPairingMessage,
          },
        ].filter((item) => item.requestId || item.message || item.scopes.length)
      : [];

  return {
    status:
      args.status ??
      ((args.identity.lastPairingStatus as PairingStatus | null) ??
        (args.identity.lastPairedAt ? "healthy" : "failed")),
    message: args.message ?? args.identity.lastPairingMessage,
    deviceId: args.identity.deviceId,
    lastPairedAt: args.identity.lastPairedAt?.toISOString() ?? null,
    tokenScopes: args.identity.tokenScopes,
    pendingRequests: args.pendingRequests ?? fallbackPending,
  };
}

export async function getGatewayPairingSummary() {
  const identity = await getStoredGatewayIdentity();
  return buildSummary({ identity });
}

export async function refreshGatewayPairingSummary() {
  const client = new OpenClawGatewayClient();

  try {
    await client.connect();
    const identity = await getStoredGatewayIdentity();
    return buildSummary({
      identity,
      status: "healthy",
      message: null,
      pendingRequests: [],
    });
  } catch (error) {
    if (error instanceof OpenClawGatewayError && error.detailCode === "PAIRING_REQUIRED") {
      let pendingRequests = error.pairingRequest ? [error.pairingRequest] : [];
      const adminClient = new OpenClawGatewayClient();

      try {
        await adminClient.connect("pairing-admin");
        const listedRequests = await adminClient.listPairingRequests();
        if (listedRequests.length) {
          pendingRequests = listedRequests;
        }
      } catch {
        // Keep the locally captured pairing request when the gateway does not expose list access.
      } finally {
        await adminClient.close();
      }

      const identity = await getStoredGatewayIdentity();
      return buildSummary({
        identity,
        status: "pairing_required",
        message: error.message,
        pendingRequests,
      });
    }

    const message = error instanceof Error ? error.message : "Failed to refresh pairing status";
    await persistGatewayPairingState({
      status: "failed",
      message,
    });
    const identity = await getStoredGatewayIdentity();
    return buildSummary({
      identity,
      status: "failed",
      message,
    });
  } finally {
    await client.close();
  }
}

export async function approveGatewayPairingRequest(requestId: string) {
  const client = new OpenClawGatewayClient();

  try {
    await persistGatewayPairingState({
      status: "approving",
      message: "Approval in progress",
      requestId,
    });

    await client.connect("pairing-admin");
    await client.approvePairingRequest(requestId);
  } finally {
    await client.close();
  }

  return refreshGatewayPairingSummary();
}
