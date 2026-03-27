import assert from "node:assert/strict";
import test from "node:test";
import { mapLazycatPickerDetailToAttachments } from "@/lib/lazycat-attachments.server";

test("mapLazycatPickerDetailToAttachments maps source paths into host paths", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"lzc-icon.png","filename":"/lazycat/team/lzc-icon.png","type":"file","size":65187,"mime":"image/png"}]',
      undefined,
    ],
    pathPrefix: "/lazycat",
    hostRoot: "/mnt/lazycat",
  });

  assert.deepEqual(attachments, [
    {
      originalName: "lzc-icon.png",
      mime: "image/png",
      size: 65187,
      sourcePath: "/lazycat/team/lzc-icon.png",
      hostPath: "/mnt/lazycat/team/lzc-icon.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments maps multiple selected files", () => {
  const attachments = mapLazycatPickerDetailToAttachments({
    detail: [
      '[{"basename":"alpha.txt","filename":"/lazycat/team/alpha.txt","type":"file","size":12,"mime":"text/plain"},{"basename":"beta.png","filename":"/lazycat/team/nested/beta.png","type":"file","size":42,"mime":"image/png"}]',
      undefined,
    ],
    pathPrefix: "/lazycat",
    hostRoot: "/mnt/lazycat",
  });

  assert.deepEqual(attachments, [
    {
      originalName: "alpha.txt",
      mime: "text/plain",
      size: 12,
      sourcePath: "/lazycat/team/alpha.txt",
      hostPath: "/mnt/lazycat/team/alpha.txt",
    },
    {
      originalName: "beta.png",
      mime: "image/png",
      size: 42,
      sourcePath: "/lazycat/team/nested/beta.png",
      hostPath: "/mnt/lazycat/team/nested/beta.png",
    },
  ]);
});

test("mapLazycatPickerDetailToAttachments rejects paths outside the configured prefix", () => {
  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"secret.txt","filename":"/elsewhere/secret.txt","type":"file"}]', undefined],
        pathPrefix: "/lazycat",
        hostRoot: "/mnt/lazycat",
      }),
    /outside the configured prefix/,
  );
});

test("mapLazycatPickerDetailToAttachments rejects non-file entries", () => {
  assert.throws(
    () =>
      mapLazycatPickerDetailToAttachments({
        detail: ['[{"basename":"folder","filename":"/lazycat/folder","type":"directory"}]', undefined],
        pathPrefix: "/lazycat",
        hostRoot: "/mnt/lazycat",
      }),
    /non-file entry/,
  );
});
