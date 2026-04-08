import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStartupEnv } from "@/lib/env";

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

function ensureWithinMaxUploadBytes(size: number) {
  const env = getStartupEnv();
  if (size > env.MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds MAX_UPLOAD_BYTES (${env.MAX_UPLOAD_BYTES})`);
  }
}

export type PersistedUpload = {
  containerPath: string;
  hostPath: string;
  size: number;
  sha256: string;
};

function buildUploadPaths(userId: string, sessionId: string, fileName: string) {
  const env = getStartupEnv();
  const now = new Date();
  const segment = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const safeName = sanitizeName(fileName || "attachment");
  const filename = `${randomUUID()}_${safeName}`;
  const relativePath = path.join(userId, segment, sessionId, filename);
  return {
    containerPath: path.join(env.ATTACHMENTS_FILE_ACCESS_ROOT, relativePath),
    hostPath: path.join(env.ATTACHMENTS_MESSAGE_PATH_ROOT, relativePath),
  };
}

async function persistUploadBuffer(userId: string, sessionId: string, fileName: string, buffer: Buffer): Promise<PersistedUpload> {
  const { containerPath, hostPath } = buildUploadPaths(userId, sessionId, fileName);

  await mkdir(path.dirname(containerPath), { recursive: true });
  await writeFile(containerPath, buffer);

  return {
    containerPath,
    hostPath,
    size: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export async function persistUpload(userId: string, sessionId: string, file: File) {
  if (!ensureMimeAllowed(file.type)) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}`);
  }

  ensureWithinMaxUploadBytes(file.size);

  return persistUploadBuffer(userId, sessionId, file.name, Buffer.from(await file.arrayBuffer()));
}

export async function persistUploadFromPath(userId: string, sessionId: string, sourcePath: string, fileName: string) {
  const buffer = await readFile(sourcePath);
  ensureWithinMaxUploadBytes(buffer.byteLength);
  return persistUploadBuffer(userId, sessionId, fileName, buffer);
}

export async function removePersistedUpload(upload: Pick<PersistedUpload, "containerPath">) {
  await rm(upload.containerPath, { force: true });
}
