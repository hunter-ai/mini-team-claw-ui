import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetStartupEnvForTests } from "@/lib/env";
import { persistUpload, persistUploadFromPath } from "@/lib/upload";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/miniteamclaw";
process.env.SESSION_SECRET ??= "12345678901234567890123456789012";

test("persistUploadFromPath copies a source file into the shared upload directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-upload-"));
  const sourcePath = path.join(root, "source.txt");
  const uploadContainer = path.join(root, "container");
  const uploadHost = path.join(root, "host");

  process.env.ATTACHMENTS_FILE_ACCESS_ROOT = uploadContainer;
  process.env.ATTACHMENTS_MESSAGE_PATH_ROOT = uploadHost;
  resetStartupEnvForTests();

  const content = Buffer.from("lazycat attachment payload");
  await writeFile(sourcePath, content);

  try {
    const saved = await persistUploadFromPath("user_1", "session_1", sourcePath, "notes.txt");
    const copied = await readFile(saved.containerPath);

    assert.equal(saved.containerPath.startsWith(uploadContainer), true);
    assert.equal(saved.hostPath.startsWith(uploadHost), true);
    assert.equal(saved.size, content.byteLength);
    assert.equal(copied.equals(content), true);
    assert.equal(saved.sha256.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUpload and persistUploadFromPath share the same relative path mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-upload-"));
  const sourcePath = path.join(root, "source.txt");
  const uploadContainer = path.join(root, "container");
  const uploadHost = path.join(root, "host");

  process.env.ATTACHMENTS_FILE_ACCESS_ROOT = uploadContainer;
  process.env.ATTACHMENTS_MESSAGE_PATH_ROOT = uploadHost;
  resetStartupEnvForTests();

  await writeFile(sourcePath, Buffer.from("lazycat attachment payload"));

  try {
    const browserUpload = await persistUpload(
      "user_1",
      "session_1",
      new File(["payload"], "notes.txt", { type: "text/plain" }),
    );
    const lazycatUpload = await persistUploadFromPath("user_1", "session_1", sourcePath, "notes.txt");

    const browserRelativeContainer = path.relative(uploadContainer, browserUpload.containerPath);
    const browserRelativeHost = path.relative(uploadHost, browserUpload.hostPath);
    const lazycatRelativeContainer = path.relative(uploadContainer, lazycatUpload.containerPath);
    const lazycatRelativeHost = path.relative(uploadHost, lazycatUpload.hostPath);

    assert.equal(browserRelativeContainer, browserRelativeHost);
    assert.equal(lazycatRelativeContainer, lazycatRelativeHost);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUpload keeps MIME validation for browser uploads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-upload-"));
  process.env.ATTACHMENTS_FILE_ACCESS_ROOT = path.join(root, "container");
  process.env.ATTACHMENTS_MESSAGE_PATH_ROOT = path.join(root, "host");
  resetStartupEnvForTests();

  try {
    await assert.rejects(
      () =>
        persistUpload(
          "user_1",
          "session_1",
          new File(["payload"], "script.js", { type: "application/javascript" }),
        ),
      /Unsupported file type/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistUploadFromPath enforces MAX_UPLOAD_BYTES without copying the file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-upload-"));
  const sourcePath = path.join(root, "source.bin");
  const uploadContainer = path.join(root, "container");
  const uploadHost = path.join(root, "host");

  process.env.ATTACHMENTS_FILE_ACCESS_ROOT = uploadContainer;
  process.env.ATTACHMENTS_MESSAGE_PATH_ROOT = uploadHost;
  process.env.MAX_UPLOAD_BYTES = "4";
  resetStartupEnvForTests();

  await writeFile(sourcePath, Buffer.from("12345"));

  try {
    await assert.rejects(
      () => persistUploadFromPath("user_1", "session_1", sourcePath, "big.bin"),
      /File exceeds MAX_UPLOAD_BYTES/,
    );
    await assert.rejects(() => access(uploadContainer));
  } finally {
    delete process.env.MAX_UPLOAD_BYTES;
    resetStartupEnvForTests();
    await rm(root, { recursive: true, force: true });
  }
});
