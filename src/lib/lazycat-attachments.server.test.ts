import assert from "node:assert/strict";
import test from "node:test";
import { mapLazycatPickerDetailToAttachments } from "@/lib/lazycat-attachments.server";

test("mapLazycatPickerDetailToAttachments maps picker paths into readable Lazycat source paths", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"lzc-icon.png","filename":"/lazycat/team/lzc-icon.png","type":"file","size":65187,"mime":"image/png"}]',
      undefined,
    ],
    username: "alice",
  });

  assert.deepEqual(attachments, [
    {
      originalName: "lzc-icon.png",
      mime: "image/png",
      sourcePath: "/lzcapp/documents/alice/lazycat/team/lzc-icon.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments maps multiple selected files", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file","size":12,"mime":"text/plain"},{"basename":"beta.png","filename":"/lazycat/team/nested/beta.png","type":"file","size":42,"mime":"image/png"}]',
      undefined,
    ],
    username: "alice",
  });

  assert.deepEqual(attachments, [
    {
      originalName: "alpha.txt",
      mime: "text/plain",
      sourcePath: "/lzcapp/documents/alice/lazycat/team/alpha.txt",
    },
    {
      originalName: "beta.png",
      mime: "image/png",
      sourcePath: "/lzcapp/documents/alice/lazycat/team/nested/beta.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments rejects missing usernames", () => {
  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file"}]', undefined],
        username: "   ",
      }),
    /username is required/,
  );
});

test("mapLazycatPickerDetailToAttachments rejects non-file entries", () => {
  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"folder","filename":"/lazycat/team/folder","type":"directory"}]', undefined],
        username: "alice",
      }),
    /non-file entry/,
  );
});
