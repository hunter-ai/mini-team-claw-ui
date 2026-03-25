import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  OPENCLAW_GATEWAY_URL: z.string().url(),
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_UPLOAD_DIR_CONTAINER: z.string().default("/shared/uploads"),
  OPENCLAW_UPLOAD_DIR_HOST: z.string().default("/srv/miniteamclaw/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  OPENCLAW_VERBOSE_LEVEL: z.enum(["off", "full"]).default("off"),
  APP_URL: z.string().url().optional(),
});

let cachedEnv: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse({
      DATABASE_URL: process.env.DATABASE_URL,
      SESSION_SECRET: process.env.SESSION_SECRET,
      OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
      OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
      OPENCLAW_UPLOAD_DIR_CONTAINER: process.env.OPENCLAW_UPLOAD_DIR_CONTAINER,
      OPENCLAW_UPLOAD_DIR_HOST: process.env.OPENCLAW_UPLOAD_DIR_HOST,
      MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
      OPENCLAW_VERBOSE_LEVEL: process.env.OPENCLAW_VERBOSE_LEVEL,
      APP_URL: process.env.APP_URL,
    });
  }

  return cachedEnv;
}
