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
import { localizeError } from "@/lib/user-facing-errors";

const payloadSchema = z.object({
  gatewayUrl: z.string(),
  gatewayAuthMode: z.enum(["token", "password"]).default("token"),
  gatewayToken: z.string().optional(),
  gatewayPassword: z.string().optional(),
  appUrl: z.string().optional(),
  preserveGatewayCredential: z.boolean().optional(),
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
          gatewayAuthMode: config.gatewayAuthMode,
          gatewayTokenConfigured: config.gatewayTokenConfigured,
          gatewayPasswordConfigured: config.gatewayPasswordConfigured,
          gatewayCredentialConfigured: config.gatewayCredentialConfigured,
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
    const preserveGatewayCredential = payload.data.preserveGatewayCredential ?? false;
    const parsed = validateRuntimeConfig(payload.data, {
      preserveGatewayCredential,
    });
    const saved = await saveRuntimeConfig(parsed, {
      preserveGatewayCredential,
    });

    return NextResponse.json({
      config: saved
        ? {
            gatewayUrl: saved.gatewayUrl,
            gatewayAuthMode: saved.gatewayAuthMode,
            gatewayTokenConfigured: saved.gatewayTokenConfigured,
            gatewayPasswordConfigured: saved.gatewayPasswordConfigured,
            gatewayCredentialConfigured: saved.gatewayCredentialConfigured,
            appUrl: saved.appUrl,
            source: saved.source,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(localizeError(access.messages, error, {
      fallbackCode: "gateway_config_missing",
      includeDiagnostic: true,
    }), { status: 400 });
  }
}
