import { z } from "zod";

function emptyToUndefined(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const startupEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ADMIN_BOOTSTRAP_MODE: z.enum(["seed", "ui"]).default("seed"),
  ENABLE_LAZYCAT_FILE_PICKER: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ATTACHMENTS_FILE_ACCESS_ROOT: z.string().default("/shared/uploads"),
  ATTACHMENTS_MESSAGE_PATH_ROOT: z.string().default("/srv/miniteamclaw/uploads"),
  LAZYCAT_SOURCE_FILE_ACCESS_ROOT: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  OPENCLAW_VERBOSE_LEVEL: z.enum(["off", "full"]).default("off"),
  OPENCLAW_GATEWAY_URL: z.string().url().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  APP_URL: z.string().url().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().optional(),
  OIDC_BRAND_NAME: z.string().optional(),
});

let cachedStartupEnv: z.infer<typeof startupEnvSchema> | null = null;

export function getStartupEnv() {
  if (!cachedStartupEnv) {
    cachedStartupEnv = startupEnvSchema.parse({
      DATABASE_URL: process.env.DATABASE_URL,
      SESSION_SECRET: process.env.SESSION_SECRET,
      ADMIN_BOOTSTRAP_MODE: emptyToUndefined(process.env.ADMIN_BOOTSTRAP_MODE),
      ENABLE_LAZYCAT_FILE_PICKER: emptyToUndefined(process.env.ENABLE_LAZYCAT_FILE_PICKER),
      ATTACHMENTS_FILE_ACCESS_ROOT: process.env.ATTACHMENTS_FILE_ACCESS_ROOT,
      ATTACHMENTS_MESSAGE_PATH_ROOT: process.env.ATTACHMENTS_MESSAGE_PATH_ROOT,
      LAZYCAT_SOURCE_FILE_ACCESS_ROOT: emptyToUndefined(process.env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT),
      MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
      OPENCLAW_VERBOSE_LEVEL: process.env.OPENCLAW_VERBOSE_LEVEL,
      OPENCLAW_GATEWAY_URL: emptyToUndefined(process.env.OPENCLAW_GATEWAY_URL),
      OPENCLAW_GATEWAY_TOKEN: emptyToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN),
      APP_URL: emptyToUndefined(process.env.APP_URL),
      OIDC_ISSUER: emptyToUndefined(process.env.OIDC_ISSUER),
      OIDC_CLIENT_ID: emptyToUndefined(process.env.OIDC_CLIENT_ID),
      OIDC_CLIENT_SECRET: emptyToUndefined(process.env.OIDC_CLIENT_SECRET),
      OIDC_SCOPES: emptyToUndefined(process.env.OIDC_SCOPES),
      OIDC_BRAND_NAME: emptyToUndefined(process.env.OIDC_BRAND_NAME),
    });
  }

  return cachedStartupEnv;
}

export function getStartupEnvDiagnostics() {
  const env = getStartupEnv();

  return {
    databaseConfigured: Boolean(env.DATABASE_URL),
    sessionSecretConfigured: Boolean(env.SESSION_SECRET),
    adminBootstrapMode: env.ADMIN_BOOTSTRAP_MODE,
    lazycatFilePickerEnabled: env.ENABLE_LAZYCAT_FILE_PICKER,
    attachmentsFileAccessRoot: env.ATTACHMENTS_FILE_ACCESS_ROOT,
    attachmentsMessagePathRoot: env.ATTACHMENTS_MESSAGE_PATH_ROOT,
    lazycatSourceFileAccessRootConfigured: Boolean(env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT?.trim()),
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    verboseLevel: env.OPENCLAW_VERBOSE_LEVEL,
    fallbackGatewayUrlConfigured: Boolean(env.OPENCLAW_GATEWAY_URL),
    fallbackGatewayTokenConfigured: Boolean(env.OPENCLAW_GATEWAY_TOKEN),
    fallbackAppUrlConfigured: Boolean(env.APP_URL),
    oidcIssuerConfigured: Boolean(env.OIDC_ISSUER),
    oidcClientIdConfigured: Boolean(env.OIDC_CLIENT_ID),
    oidcClientSecretConfigured: Boolean(env.OIDC_CLIENT_SECRET),
    oidcBrandNameConfigured: Boolean(env.OIDC_BRAND_NAME),
  };
}

export function resetStartupEnvForTests() {
  cachedStartupEnv = null;
}
