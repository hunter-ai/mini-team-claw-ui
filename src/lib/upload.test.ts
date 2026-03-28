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

  process.env.OPENCLAW_UPLOAD_DIR_CONTAINER = uploadContainer;
  process.env.OPENCLAW_UPLOAD_DIR_HOST = uploadHost;
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

test("persistUpload keeps MIME validation for browser uploads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mtc-upload-"));
  process.env.OPENCLAW_UPLOAD_DIR_CONTAINER = path.join(root, "container");
  process.env.OPENCLAW_UPLOAD_DIR_HOST = path.join(root, "host");
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

  process.env.OPENCLAW_UPLOAD_DIR_CONTAINER = uploadContainer;
  process.env.OPENCLAW_UPLOAD_DIR_HOST = uploadHost;
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
