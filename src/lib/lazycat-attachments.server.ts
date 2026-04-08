import path from "node:path";
import {
  parseLazycatPickerEntries,
  type LazycatPickerSubmitDetail,
} from "@/lib/lazycat-attachments";
import { getStartupEnv } from "@/lib/env";

function normalizeAbsolutePosixPath(value: string, label: string) {
  const normalized = path.posix.normalize(value.trim());
  if (!normalized.startsWith("/")) {
    throw new Error(`${label} must be an absolute path.`);
  }

  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export type LazycatMappedAttachmentInput = {
  originalName: string;
  mime: string;
  sourcePath: string;
};

export function mapLazycatPickerDetailToAttachments({
  detail,
}: {
  detail: LazycatPickerSubmitDetail;
}) {
  const env = getStartupEnv();
  const configuredAccessRoot = env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT?.trim();
  if (!configuredAccessRoot) {
    throw new Error("LAZYCAT_SOURCE_FILE_ACCESS_ROOT is not configured.");
  }
  const lazycatFileAccessRoot = normalizeAbsolutePosixPath(
    configuredAccessRoot,
    "Lazycat source file access root",
  );

  return parseLazycatPickerEntries(detail).map((entry) => {
    if (entry.type !== "file") {
      throw new Error("Lazycat picker returned a non-file entry.");
    }

    if (!entry.filename?.trim()) {
      throw new Error("Lazycat picker returned a file without filename.");
    }

    const normalizedFilename = normalizeAbsolutePosixPath(entry.filename, "Lazycat filename");
    const normalizedRelativePath = normalizedFilename.replace(/^\/+/, "");

    return {
      originalName: entry.basename?.trim() || path.posix.basename(normalizedFilename),
      mime: entry.mime?.trim() || "application/octet-stream",
      sourcePath: path.posix.join(lazycatFileAccessRoot, normalizedRelativePath),
    } satisfies LazycatMappedAttachmentInput;
  });
}
