import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import {
  getResolvedRuntimeConfig,
  saveRuntimeConfig,
  validateRuntimeConfig,
} from "@/lib/runtime-config";
import { getSetupStatus } from "@/lib/setup";

const payloadSchema = z.object({
  gatewayUrl: z.string(),
  gatewayToken: z.string().optional(),
  appUrl: z.string().optional(),
  preserveGatewayToken: z.boolean().optional(),
});

async function requireSetupEditor(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const [setupStatus, user] = await Promise.all([getSetupStatus(), getCurrentUser()]);

  if (setupStatus.isComplete && (!user || user.role !== UserRole.ADMIN)) {
    return {
      error: NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 }),
      locale,
      messages,
      setupStatus,
      user,
    };
  }

  return { error: null, locale, messages, setupStatus, user };
}

export async function GET(request: Request) {
  const access = await requireSetupEditor(request);
  if (access.error) {
    return access.error;
  }

  const config = await getResolvedRuntimeConfig();
  return NextResponse.json({
    config: config
      ? {
          gatewayUrl: config.gatewayUrl,
          gatewayTokenConfigured: config.gatewayTokenConfigured,
          appUrl: config.appUrl,
          source: config.source,
        }
      : null,
  });
}

export async function PUT(request: Request) {
  const access = await requireSetupEditor(request);
  if (access.error) {
    return access.error;
  }

  const payload = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!payload.success) {
    return NextResponse.json({ error: access.messages.auth.invalidPayload }, { status: 400 });
  }

  try {
    const preserveGatewayToken = payload.data.preserveGatewayToken ?? false;
    const parsed = validateRuntimeConfig(payload.data, {
      requireGatewayToken: !preserveGatewayToken,
    });
    const saved = await saveRuntimeConfig(parsed, {
      preserveGatewayToken,
    });

    return NextResponse.json({
      config: saved
        ? {
            gatewayUrl: saved.gatewayUrl,
            gatewayTokenConfigured: saved.gatewayTokenConfigured,
            appUrl: saved.appUrl,
            source: saved.source,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : access.messages.auth.invalidPayload },
      { status: 400 },
    );
  }
}
