import { NextResponse } from "next/server";
import { SessionStatus } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { getActiveChatRunForSession } from "@/lib/chat-run-service";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { sendToOpenClaw } from "@/lib/openclaw/chat";
import { OpenClawGatewayError } from "@/lib/openclaw/gateway";
import { prisma } from "@/lib/prisma";
import { parseSessionContextUsage } from "@/lib/session-context-usage";
import { errorFromCode } from "@/lib/user-facing-errors";

export const runtime = "nodejs";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const messages = await getDictionary(await resolveRequestLocale(request));
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  const { sessionId } = await params;
  const session = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      userId: user.id,
    },
    select: {
      id: true,
      agentId: true,
      openclawSessionId: true,
      status: true,
    },
  });

  if (!session) {
    return NextResponse.json({ error: messages.sessions.sessionNotFound }, { status: 404 });
  }

  if (session.status === SessionStatus.ARCHIVED) {
    return NextResponse.json({ status: "unavailable" }, { status: 200 });
  }

  const activeRun = await getActiveChatRunForSession(user.id, session.id);
  if (activeRun) {
    return NextResponse.json({ status: "busy" }, { status: 200 });
  }

  try {
    const result = await sendToOpenClaw({
      agentId: session.agentId,
      openclawSessionId: session.openclawSessionId,
      message: "/context json",
    });

    const usage = parseSessionContextUsage(result.content);
    if (!usage) {
      return NextResponse.json({ status: "unavailable" }, { status: 200 });
    }

    return NextResponse.json({
      status: "ok",
      usage,
    });
  } catch (error) {
    if (error instanceof OpenClawGatewayError && error.detailCode === "PAIRING_REQUIRED") {
      const details = isObject(error.details) ? error.details : null;
      const localized = errorFromCode(messages, "gateway_pairing_required");

      return NextResponse.json({
        status: "pairing_required",
        pairing: {
          status: "pairing_required",
          message: localized.error,
          deviceId: readString(details?.deviceId) ?? null,
          lastPairedAt: readDateIso(details?.lastPairedAt) ?? null,
          pendingRequests: error.pairingRequest ? [error.pairingRequest] : [],
        },
      });
    }

    console.error("[api/context] failed to fetch session context usage", {
      sessionId: session.id,
      userId: user.id,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : { message: String(error) },
    });

    return NextResponse.json({ status: "unavailable" }, { status: 200 });
  }
}
