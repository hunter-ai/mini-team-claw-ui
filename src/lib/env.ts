import { z } from "zod";

const startupEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  OPENCLAW_UPLOAD_DIR_CONTAINER: z.string().default("/shared/uploads"),
  OPENCLAW_UPLOAD_DIR_HOST: z.string().default("/srv/miniteamclaw/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  OPENCLAW_VERBOSE_LEVEL: z.enum(["off", "full"]).default("off"),
  OPENCLAW_GATEWAY_URL: z.string().url().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  APP_URL: z.string().url().optional(),
});

let cachedStartupEnv: z.infer<typeof startupEnvSchema> | null = null;

export function getStartupEnv() {
  if (!cachedStartupEnv) {
    cachedStartupEnv = startupEnvSchema.parse({
      DATABASE_URL: process.env.DATABASE_URL,
      SESSION_SECRET: process.env.SESSION_SECRET,
      OPENCLAW_UPLOAD_DIR_CONTAINER: process.env.OPENCLAW_UPLOAD_DIR_CONTAINER,
      OPENCLAW_UPLOAD_DIR_HOST: process.env.OPENCLAW_UPLOAD_DIR_HOST,
      MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
      OPENCLAW_VERBOSE_LEVEL: process.env.OPENCLAW_VERBOSE_LEVEL,
      OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
      OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
      APP_URL: process.env.APP_URL,
    });
  }

  return cachedStartupEnv;
}

export function getStartupEnvDiagnostics() {
  const env = getStartupEnv();

  return {
    databaseConfigured: Boolean(env.DATABASE_URL),
    sessionSecretConfigured: Boolean(env.SESSION_SECRET),
    uploadDirContainer: env.OPENCLAW_UPLOAD_DIR_CONTAINER,
    uploadDirHost: env.OPENCLAW_UPLOAD_DIR_HOST,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    verboseLevel: env.OPENCLAW_VERBOSE_LEVEL,
    fallbackGatewayUrlConfigured: Boolean(env.OPENCLAW_GATEWAY_URL),
    fallbackGatewayTokenConfigured: Boolean(env.OPENCLAW_GATEWAY_TOKEN),
    fallbackAppUrlConfigured: Boolean(env.APP_URL),
  };
}
