import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLazycatAttachments } from "@/lib/lazycat-attachments-persistence";
import type { LazycatMappedAttachmentInput } from "@/lib/lazycat-attachments.server";
import type { PersistedUpload } from "@/lib/upload";

type TransactionCallback<T> = (tx: {
  attachment: {
    create: (args: { data: LazycatMappedAttachmentInput & PersistedUpload }) => Promise<T>;
  };
}) => Promise<unknown>;

async function buildPersistedUpload(root: string, name: string, content: string): Promise<PersistedUpload> {
  const containerPath = path.join(root, `${name}.bin`);
  await mkdir(path.dirname(containerPath), { recursive: true });
  await writeFile(containerPath, content);
  return {
    containerPath,
    hostPath: `/host/${name}.bin`,
    size: Buffer.byteLength(content),
    sha256: `${name}-sha`,
  };
}

test("createLazycatAttachments removes copied files when a later copy fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-lazycat-persist-"));
  const copiedPaths: string[] = [];
  const attachments: LazycatMappedAttachmentInput[] = [
    { originalName: "alpha.txt", mime: "text/plain", sourcePath: "/lzcapp/documents/alice/lazycat/team/alpha.txt" },
    { originalName: "beta.txt", mime: "text/plain", sourcePath: "/lzcapp/documents/alice/lazycat/team/beta.txt" },
  ];

  try {
    await assert.rejects(
      () =>
        createLazycatAttachments({
          userId: "user_1",
          sessionId: "session_1",
          attachments,
          dependencies: {
            persistUploadFromPath: async (_userId, _sessionId, sourcePath) => {
              if (sourcePath.endsWith("beta.txt")) {
                throw new Error("copy failed");
              }
              const saved = await buildPersistedUpload(root, "alpha", "alpha");
              copiedPaths.push(saved.containerPath);
              return saved;
            },
            removePersistedUpload: async (upload) => {
              await rm(upload.containerPath, { force: true });
            },
            transaction: (async () => {
              throw new Error("transaction should not run");
            }) as never,
          },
        }),
      /copy failed/,
    );

    assert.equal(copiedPaths.length, 1);
    await assert.rejects(() => access(copiedPaths[0] as string));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLazycatAttachments removes copied files when the database transaction fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-lazycat-persist-"));
  const copiedPaths: string[] = [];
  const attachments: LazycatMappedAttachmentInput[] = [
    { originalName: "alpha.txt", mime: "text/plain", sourcePath: "/lzcapp/documents/alice/lazycat/team/alpha.txt" },
    { originalName: "beta.txt", mime: "text/plain", sourcePath: "/lzcapp/documents/alice/lazycat/team/beta.txt" },
  ];

  try {
    await assert.rejects(
      () =>
        createLazycatAttachments({
          userId: "user_1",
          sessionId: "session_1",
          attachments,
          dependencies: {
            persistUploadFromPath: async (_userId, _sessionId, sourcePath) => {
              const name = path.basename(sourcePath, ".txt");
              const saved = await buildPersistedUpload(root, name, name);
              copiedPaths.push(saved.containerPath);
              return saved;
            },
            removePersistedUpload: async (upload) => {
              await rm(upload.containerPath, { force: true });
            },
            transaction: (async (callback: TransactionCallback<never>) => {
              await callback({
                attachment: {
                  create: async () => {
                    throw new Error("database failed");
                  },
                },
              } as never);
              throw new Error("unreachable");
            }) as never,
          },
        }),
      /database failed/,
    );

    assert.equal(copiedPaths.length, 2);
    await Promise.all(copiedPaths.map(async (copiedPath) => assert.rejects(() => access(copiedPath))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLazycatAttachments returns created attachment summaries after a successful transaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-lazycat-persist-"));
  const attachments: LazycatMappedAttachmentInput[] = [
    { originalName: "alpha.txt", mime: "text/plain", sourcePath: "/lzcapp/documents/alice/lazycat/team/alpha.txt" },
    { originalName: "beta.txt", mime: "image/png", sourcePath: "/lzcapp/documents/alice/lazycat/team/beta.txt" },
  ];
  let createdCount = 0;

  try {
    const created = await createLazycatAttachments({
      userId: "user_1",
      sessionId: "session_1",
      attachments,
      dependencies: {
        persistUploadFromPath: async (_userId, _sessionId, sourcePath, fileName) => {
          const name = path.basename(sourcePath, ".txt");
          return buildPersistedUpload(root, fileName.replace(/\W+/g, "_"), name);
        },
        removePersistedUpload: async (upload) => {
          await rm(upload.containerPath, { force: true });
        },
        transaction: (async (callback: TransactionCallback<{ id: string; originalName: string; mime: string; size: number }>) =>
          callback({
            attachment: {
              create: async ({ data }: { data: LazycatMappedAttachmentInput & PersistedUpload }) => {
                createdCount += 1;
                assert.equal(data.hostPath.startsWith("/host/"), true);
                return {
                  id: `attachment_${createdCount}`,
                  originalName: data.originalName,
                  mime: data.mime,
                  size: data.size,
                };
              },
            },
          } as never)) as never,
      },
    });

    assert.deepEqual(created, [
      { id: "attachment_1", originalName: "alpha.txt", mime: "text/plain", size: 5 },
      { id: "attachment_2", originalName: "beta.txt", mime: "image/png", size: 4 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
