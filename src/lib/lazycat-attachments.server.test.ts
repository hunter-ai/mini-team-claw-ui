import assert from "node:assert/strict";
import test from "node:test";
import { resetStartupEnvForTests } from "@/lib/env";
import { mapLazycatPickerDetailToAttachments } from "@/lib/lazycat-attachments.server";

test.beforeEach(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.SESSION_SECRET ??= "12345678901234567890123456789012";
  process.env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT ??= "/lzcapp/run/mnt/home/hunter";
  resetStartupEnvForTests();
});

test.afterEach(() => {
  delete process.env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT;
  resetStartupEnvForTests();
});

test("mapLazycatPickerDetailToAttachments maps picker paths into readable Lazycat source paths", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"lzc-icon.png","filename":"/lazycat/team/lzc-icon.png","type":"file","size":65187,"mime":"image/png"}]',
      undefined,
    ],
  });

  assert.deepEqual(attachments, [
    {
      originalName: "lzc-icon.png",
      mime: "image/png",
      sourcePath: "/lzcapp/run/mnt/home/hunter/lazycat/team/lzc-icon.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments maps multiple selected files", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file","size":12,"mime":"text/plain"},{"basename":"beta.png","filename":"/lazycat/team/nested/beta.png","type":"file","size":42,"mime":"image/png"}]',
      undefined,
    ],
  });

  assert.deepEqual(attachments, [
    {
      originalName: "alpha.txt",
      mime: "text/plain",
      sourcePath: "/lzcapp/run/mnt/home/hunter/lazycat/team/alpha.txt",
    },
    {
      originalName: "beta.png",
      mime: "image/png",
      sourcePath: "/lzcapp/run/mnt/home/hunter/lazycat/team/nested/beta.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments rejects missing configured access roots", () => {
  delete process.env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT;
  resetStartupEnvForTests();

  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file"}]', undefined],
      }),
    /LAZYCAT_SOURCE_FILE_ACCESS_ROOT is not configured/,
  );
});

test("mapLazycatPickerDetailToAttachments rejects non-file entries", () => {
  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"folder","filename":"/lazycat/team/folder","type":"directory"}]', undefined],
      }),
    /non-file entry/,
  );
});

test("mapLazycatPickerDetailToAttachments reads the Lazycat root from env", () => {
  process.env.LAZYCAT_SOURCE_FILE_ACCESS_ROOT = "/lzcapp/run/mnt/home/custom-user";
  resetStartupEnvForTests();

  const attachments = mapLazycatPickerDetailToAttachments({
    detail: ['[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file","mime":"text/plain"}]', undefined],
  });

  assert.deepEqual(attachments, [
    {
      originalName: "alpha.txt",
      mime: "text/plain",
      sourcePath: "/lzcapp/run/mnt/home/custom-user/lazycat/team/alpha.txt",
    },
  ]);
});
