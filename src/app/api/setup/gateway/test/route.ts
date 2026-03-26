import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { OpenClawGatewayClient, OpenClawGatewayError } from "@/lib/openclaw/gateway";
import { getSetupStatus } from "@/lib/setup";

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

export async function POST(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const [setupStatus, user] = await Promise.all([getSetupStatus(), getCurrentUser()]);

  if (setupStatus.isComplete && (!user || user.role !== UserRole.ADMIN)) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const client = new OpenClawGatewayClient();

  try {
    await client.connect();
    return NextResponse.json({
      status: "healthy",
    });
  } catch (error) {
    if (error instanceof OpenClawGatewayError) {
      if (error.detailCode === "PAIRING_REQUIRED") {
        const details = isObject(error.details) ? error.details : null;
        return NextResponse.json({
          status: "pairing_required",
          message: error.message,
          pairing: {
            status: "pairing_required",
            message: error.message,
            deviceId: readString(details?.deviceId) ?? null,
            lastPairedAt: readDateIso(details?.lastPairedAt) ?? null,
            pendingRequests: error.pairingRequest ? [error.pairingRequest] : [],
          },
        });
      }

      if (
        error.detailCode === "AUTH_TOKEN_MISMATCH" ||
        error.detailCode === "AUTH_DEVICE_TOKEN_MISMATCH"
      ) {
        return NextResponse.json({ status: "auth_failed", message: error.message }, { status: 200 });
      }

      return NextResponse.json({ status: "unreachable", message: error.message }, { status: 200 });
    }

    return NextResponse.json(
      {
        status: "invalid_config",
        message: error instanceof Error ? error.message : messages.chat.skillsConnectionFailed,
      },
      { status: 200 },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
