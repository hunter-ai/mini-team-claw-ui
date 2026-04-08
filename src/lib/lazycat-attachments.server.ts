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
  const configuredRoot = getStartupEnv().LAZYCAT_DOCUMENTS_ROOT?.trim();
  if (!configuredRoot) {
    throw new Error("LAZYCAT_DOCUMENTS_ROOT is not configured.");
  }
  const lazycatDocumentsRoot = normalizeAbsolutePosixPath(
    configuredRoot,
    "Lazycat documents root",
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
      sourcePath: path.posix.join(lazycatDocumentsRoot, normalizedRelativePath),
    } satisfies LazycatMappedAttachmentInput;
  });
}
