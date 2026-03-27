import assert from "node:assert/strict";
import test from "node:test";
import { ChatRunStatus, MessageRole } from "@prisma/client";
import {
  buildSessionShareSnapshot,
  createShareAccessCookieValue,
  readShareAccessCookieValue,
} from "@/lib/session-share";

test("buildSessionShareSnapshot keeps message order and attachment metadata", () => {
  const snapshot = buildSessionShareSnapshot({
    id: "session_1",
    title: "Shared session",
    messages: [
      {
        id: "message_1",
        role: MessageRole.USER,
        content: "hello",
        attachmentIds: ["att_1"],
        selectedSkillsJson: [{ key: "skill_1", name: "Skill One", source: "bundled", bundled: true }],
        createdAt: new Date("2026-03-27T10:00:00.000Z"),
      },
    ],
    attachments: [
      {
        id: "att_1",
        originalName: "notes.txt",
        mime: "text/plain",
        size: 128,
      },
    ],
    runs: [
      {
        id: "run_1",
        userMessageId: "message_1",
        assistantMessageId: null,
        status: ChatRunStatus.STREAMING,
        draftAssistantContent: "draft",
        errorMessage: null,
        startedAt: new Date("2026-03-27T10:00:01.000Z"),
        updatedAt: new Date("2026-03-27T10:00:02.000Z"),
        events: [],
      },
    ],
  });

  assert.equal(snapshot.title, "Shared session");
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0]?.attachments[0]?.originalName, "notes.txt");
  assert.equal(snapshot.messages[0]?.skills[0]?.name, "Skill One");
  assert.equal(snapshot.runHistory[0]?.status, ChatRunStatus.ABORTED);
});

test("share access cookie round-trips signed values", () => {
  const value = createShareAccessCookieValue("public_123", 4);
  assert.deepEqual(readShareAccessCookieValue(value), {
    publicId: "public_123",
    accessVersion: 4,
  });
});

test("share access cookie rejects tampering", () => {
  const value = createShareAccessCookieValue("public_123", 4);
  assert.equal(readShareAccessCookieValue(`${value}tampered`), null);
});
