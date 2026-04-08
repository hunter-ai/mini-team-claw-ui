import { AttachmentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  persistUploadFromPath,
  removePersistedUpload,
} from "@/lib/upload";
import type { LazycatMappedAttachmentInput } from "@/lib/lazycat-attachments.server";

type PersistedLazycatAttachment = LazycatMappedAttachmentInput & {
  containerPath: string;
  hostPath: string;
  size: number;
  sha256: string;
};

type AttachmentSummary = {
  id: string;
  originalName: string;
  mime: string;
  size: number;
};

type LazycatPersistenceDependencies = {
  persistUploadFromPath: typeof persistUploadFromPath;
  removePersistedUpload: typeof removePersistedUpload;
  transaction: typeof prisma.$transaction;
};

const defaultDependencies: LazycatPersistenceDependencies = {
  persistUploadFromPath,
  removePersistedUpload,
  transaction: prisma.$transaction.bind(prisma),
};

async function cleanupPersistedUploads(
  savedUploads: Array<Pick<PersistedLazycatAttachment, "containerPath">>,
  removeUpload: LazycatPersistenceDependencies["removePersistedUpload"],
) {
  await Promise.allSettled(savedUploads.map((upload) => removeUpload(upload)));
}

export async function createLazycatAttachments({
  userId,
  sessionId,
  attachments,
  dependencies = defaultDependencies,
}: {
  userId: string;
  sessionId: string;
  attachments: LazycatMappedAttachmentInput[];
  dependencies?: LazycatPersistenceDependencies;
}): Promise<AttachmentSummary[]> {
  const savedUploads: PersistedLazycatAttachment[] = [];

  try {
    for (const attachment of attachments) {
      const saved = await dependencies.persistUploadFromPath(
        userId,
        sessionId,
        attachment.sourcePath,
        attachment.originalName,
      );
      savedUploads.push({
        ...attachment,
        containerPath: saved.containerPath,
        hostPath: saved.hostPath,
        size: saved.size,
        sha256: saved.sha256,
      });
    }
  } catch (error) {
    await cleanupPersistedUploads(savedUploads, dependencies.removePersistedUpload);
    throw error;
  }

  try {
    return await dependencies.transaction(async (tx) =>
      Promise.all(
        savedUploads.map(async (attachment) => {
          const created = await tx.attachment.create({
            data: {
              userId,
              sessionId,
              source: AttachmentSource.LAZYCAT_PATH,
              originalName: attachment.originalName,
              mime: attachment.mime,
              size: attachment.size,
              sha256: attachment.sha256,
              containerPath: attachment.containerPath,
              sourcePath: attachment.sourcePath,
              hostPath: attachment.hostPath,
            },
          });

          return {
            id: created.id,
            originalName: created.originalName,
            mime: created.mime,
            size: created.size,
          };
        }),
      ),
    );
  } catch (error) {
    await cleanupPersistedUploads(savedUploads, dependencies.removePersistedUpload);
    throw error;
  }
}

export type { AttachmentSummary, LazycatPersistenceDependencies };
