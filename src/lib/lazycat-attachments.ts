import path from "node:path";
import { z } from "zod";

export const lazycatPickerSubmitDetailSchema = z.union([
  z.string().trim().min(1),
  z.tuple([z.string().trim().min(1), z.array(z.string()).nullish()]),
]);

export type LazycatPickerSubmitDetail = z.infer<typeof lazycatPickerSubmitDetailSchema>;

const lazycatEntrySchema = z.object({
  basename: z.string().optional(),
  filename: z.string().optional(),
  type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  mime: z.string().optional(),
});

function normalizeAbsolutePosixPath(value: string, label: string) {
  const normalized = path.posix.normalize(value.trim());
  if (!normalized.startsWith("/")) {
    throw new Error(`${label} must be an absolute path.`);
  }

  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function isLazycatPickerSubmitDetail(detail: unknown): detail is LazycatPickerSubmitDetail {
  return lazycatPickerSubmitDetailSchema.safeParse(detail).success;
}

function resolveLazycatPayloadCandidate(detail: LazycatPickerSubmitDetail) {
  if (typeof detail === "string") {
    return detail;
  }

  return detail[0];
}

function stripPathPrefix(filename: string, prefix: string) {
  if (prefix === "/") {
    return filename.replace(/^\/+/, "");
  }

  if (filename === prefix) {
    return "";
  }

  if (!filename.startsWith(`${prefix}/`)) {
    throw new Error(`Lazycat path is outside the configured prefix: ${filename}`);
  }

  return filename.slice(prefix.length + 1);
}

export type LazycatMappedAttachmentInput = {
  originalName: string;
  mime: string;
  size: number;
  sourcePath: string;
  hostPath: string;
};

export function parseLazycatPickerEntries(detail: LazycatPickerSubmitDetail) {
  const payload = resolveLazycatPayloadCandidate(detail);
  const parsed = JSON.parse(payload) as unknown;
  const result = z.array(lazycatEntrySchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("Lazycat picker payload is not a valid file list.");
  }

  if (result.data.length === 0) {
    throw new Error("Lazycat picker payload did not include any files.");
  }

  return result.data;
}

export function mapLazycatPickerDetailToAttachments({
  detail,
  pathPrefix,
  hostRoot,
}: {
  detail: LazycatPickerSubmitDetail;
  pathPrefix: string;
  hostRoot: string;
}) {
  const normalizedPrefix = normalizeAbsolutePosixPath(pathPrefix, "LAZYCAT_PICKER_PATH_PREFIX");
  const normalizedHostRoot = normalizeAbsolutePosixPath(hostRoot, "OPENCLAW_LAZYCAT_HOST_ROOT");

  return parseLazycatPickerEntries(detail).map((entry) => {
    if (entry.type !== "file") {
      throw new Error("Lazycat picker returned a non-file entry.");
    }

    if (!entry.filename?.trim()) {
      throw new Error("Lazycat picker returned a file without filename.");
    }

    const normalizedFilename = normalizeAbsolutePosixPath(entry.filename, "Lazycat filename");
    const relativePath = stripPathPrefix(normalizedFilename, normalizedPrefix);
    const normalizedRelativePath = path.posix.normalize(relativePath).replace(/^\/+/, "");

    if (!normalizedRelativePath || normalizedRelativePath === "." || normalizedRelativePath.startsWith("..")) {
      throw new Error(`Lazycat file path is invalid: ${entry.filename}`);
    }

    return {
      originalName: entry.basename?.trim() || path.posix.basename(normalizedFilename),
      mime: entry.mime?.trim() || "application/octet-stream",
      size: entry.size ?? 0,
      sourcePath: normalizedFilename,
      hostPath: path.posix.join(normalizedHostRoot, normalizedRelativePath),
    } satisfies LazycatMappedAttachmentInput;
  });
}
