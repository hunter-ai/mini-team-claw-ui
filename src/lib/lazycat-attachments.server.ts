import path from "node:path";
import {
  parseLazycatPickerEntries,
  type LazycatPickerSubmitDetail,
} from "@/lib/lazycat-attachments";

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
  username,
}: {
  detail: LazycatPickerSubmitDetail;
  username: string;
}) {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) {
    throw new Error("Lazycat username is required.");
  }

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
      sourcePath: path.posix.join("/lzcapp/documents", normalizedUsername, normalizedRelativePath),
    } satisfies LazycatMappedAttachmentInput;
  });
}
