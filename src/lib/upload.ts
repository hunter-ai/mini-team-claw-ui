import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

function sanitizeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

export function ensureMimeAllowed(mime: string) {
  return allowedMimeTypes.has(mime);
}

export async function persistUpload(userId: string, file: File) {
  const env = getEnv();
  if (!ensureMimeAllowed(file.type)) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}`);
  }

  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds MAX_UPLOAD_BYTES (${env.MAX_UPLOAD_BYTES})`);
  }

  const now = new Date();
  const segment = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const safeName = sanitizeName(file.name || "attachment");
  const filename = `${randomUUID()}_${safeName}`;
  const relativePath = path.join(userId, segment, filename);
  const containerPath = path.join(env.OPENCLAW_UPLOAD_DIR_CONTAINER, relativePath);
  const hostPath = path.join(env.OPENCLAW_UPLOAD_DIR_HOST, relativePath);

  await mkdir(path.dirname(containerPath), { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(containerPath, buffer);

  return {
    containerPath,
    hostPath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}
