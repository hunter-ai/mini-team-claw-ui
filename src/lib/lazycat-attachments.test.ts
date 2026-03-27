import assert from "node:assert/strict";
import test from "node:test";
import {
  isLazycatPickerSubmitDetail,
  parseLazycatPickerEntries,
} from "@/lib/lazycat-attachments";

test("isLazycatPickerSubmitDetail accepts the real submit detail shapes", () => {
  assert.equal(isLazycatPickerSubmitDetail('[{"filename":"/lazycat/team/a.txt","type":"file"}]'), true);
  assert.equal(
    isLazycatPickerSubmitDetail([
      '[{"filename":"/lazycat/team/a.txt","type":"file"}]',
      undefined,
    ]),
    true,
  );
  assert.equal(
    isLazycatPickerSubmitDetail([
      '[{"filename":"/lazycat/team/a.txt","type":"file"}]',
      ["source"],
    ]),
    true,
  );
  assert.equal(
    isLazycatPickerSubmitDetail([
      '[{"filename":"/lazycat/team/a.txt","type":"file"}]',
      null,
    ]),
    true,
  );
});

test("isLazycatPickerSubmitDetail rejects unsupported submit detail shapes", () => {
  assert.equal(isLazycatPickerSubmitDetail(""), false);
  assert.equal(isLazycatPickerSubmitDetail([undefined, undefined]), false);
  assert.equal(isLazycatPickerSubmitDetail([{ filename: "/lazycat/team/a.txt" }]), false);
  assert.equal(isLazycatPickerSubmitDetail(["one", "two", "three"]), false);
});

test("parseLazycatPickerEntries accepts the actual submit detail shape", () => {
  const entries = parseLazycatPickerEntries([
    '[{"basename":"lzc-icon.png","filename":"/lazycat/team/lzc-icon.png","type":"file","size":65187,"mime":"image/png"}]',
    undefined,
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.filename, "/lazycat/team/lzc-icon.png");
});

test("parseLazycatPickerEntries accepts the JSON-serialized tuple shape", () => {
  const entries = parseLazycatPickerEntries([
    '[{"basename":"lzc-icon.png","filename":"/lazycat/team/lzc-icon.png","type":"file","size":65187,"mime":"image/png"}]',
    null,
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.filename, "/lazycat/team/lzc-icon.png");
});
