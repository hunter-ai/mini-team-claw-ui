import assert from "node:assert/strict";
import test from "node:test";
import { ChatRunStatus, MessageRole, SessionStatus } from "@prisma/client";
import { serializeChatRunEvent, serializeRunHistoryItem } from "@/lib/chat-run-events";
import { serializeChatSessionDetail } from "@/lib/chat-response";
import en from "@/lib/i18n/dictionaries/en";
import zh from "@/lib/i18n/dictionaries/zh";

test("serializeRunHistoryItem localizes persisted errors and preserves diagnostics", () => {
  const run = {
    id: "run_1",
    userMessageId: "msg_user",
    assistantMessageId: null,
    status: "FAILED" as const,
    draftAssistantContent: "",
    errorMessage: "[openclaw] connect rejected: gateway auth token mismatch.",
    startedAt: new Date("2026-04-16T10:00:00.000Z"),
    updatedAt: new Date("2026-04-16T10:00:05.000Z"),
    events: [
      {
        runId: "run_1",
        seq: 1,
        type: "error",
        delta: null,
        payloadJson: {
          error: "[openclaw] connect rejected: gateway auth token mismatch.",
        },
        createdAt: new Date("2026-04-16T10:00:05.000Z"),
      },
    ],
  };

  const localized = serializeRunHistoryItem(run, zh);

  assert.equal(localized.errorMessage, zh.errors.gatewayAuthFailed);
  assert.equal(localized.errorDiagnostic, "[openclaw] connect rejected: gateway auth token mismatch.");
  assert.equal(localized.steps[0]?.kind, "lifecycle");
  assert.equal(localized.steps[0]?.detail, zh.errors.gatewayAuthFailed);
  assert.equal(localized.steps[0]?.diagnostic, "[openclaw] connect rejected: gateway auth token mismatch.");
});

test("serializeChatRunEvent includes localized message and raw diagnostic", () => {
  const event = {
    runId: "run_1",
    seq: 2,
    type: "pairing_required",
    delta: null,
    payloadJson: {
      pairing: {
        message: "[openclaw] connect rejected: device pairing required.",
        deviceId: "dev_1",
        lastPairedAt: null,
        pendingRequests: [],
      },
    },
    createdAt: new Date("2026-04-16T10:00:05.000Z"),
  };

  const localized = serializeChatRunEvent(event, zh);
  assert(localized && localized.type === "pairing_required");
  assert.equal(localized.pairing.message, zh.errors.gatewayPairingRequired);
  assert.equal(localized.pairing.diagnostic, "[openclaw] connect rejected: device pairing required.");
});

test("serializeChatRunEvent preserves empty completion diagnostics on done events", () => {
  const event = {
    runId: "run_1",
    seq: 3,
    type: "done",
    delta: null,
    payloadJson: {
      content: "",
      renderMode: "plain_text",
      completionIssue: {
        code: "empty_text",
        diagnostic: "OpenClaw completed without returning text.",
      },
    },
    createdAt: new Date("2026-04-16T10:00:06.000Z"),
  };

  const serialized = serializeChatRunEvent(event, zh);
  assert(serialized && serialized.type === "done");
  assert.equal(serialized.content, "");
  assert.deepEqual(serialized.completionIssue, {
    code: "empty_text",
    diagnostic: "OpenClaw completed without returning text.",
  });
});

test("serializeRunHistoryItem preserves empty completion diagnostics", () => {
  const run = {
    id: "run_2",
    userMessageId: "msg_user",
    assistantMessageId: "msg_assistant",
    status: "COMPLETED" as const,
    draftAssistantContent: "",
    errorMessage: null,
    startedAt: new Date("2026-04-16T10:00:00.000Z"),
    updatedAt: new Date("2026-04-16T10:00:06.000Z"),
    events: [
      {
        runId: "run_2",
        seq: 2,
        type: "done",
        delta: null,
        payloadJson: {
          content: "",
          renderMode: "plain_text",
          completionIssue: {
            code: "empty_text",
            diagnostic: "OpenClaw completed without returning text.",
          },
        },
        createdAt: new Date("2026-04-16T10:00:06.000Z"),
      },
    ],
  };

  const serialized = serializeRunHistoryItem(run, zh);

  assert.deepEqual(serialized.completionIssue, {
    code: "empty_text",
    diagnostic: "OpenClaw completed without returning text.",
  });
  assert.equal(serialized.draftAssistantContent, "");
  assert.equal(serialized.errorMessage, null);
});

test("serializeChatSessionDetail reuses localized run history for initial chat payload", () => {
  const detail = serializeChatSessionDetail(
    {
      id: "session_1",
      title: "Test",
      status: SessionStatus.ACTIVE,
      updatedAt: new Date("2026-04-16T10:00:05.000Z"),
      lastMessageAt: new Date("2026-04-16T10:00:05.000Z"),
      messages: [
        {
          id: "msg_user",
          role: MessageRole.USER,
          content: "hello",
          createdAt: new Date("2026-04-16T10:00:00.000Z"),
          attachmentIds: [],
          selectedSkillsJson: null,
        },
      ],
      attachments: [],
      runs: [
        {
          id: "run_1",
          userMessageId: "msg_user",
          assistantMessageId: null,
          status: ChatRunStatus.FAILED,
          clientRequestId: "req_1",
          lastEventSeq: 0,
          draftAssistantContent: "",
          errorMessage: "[openclaw] connect rejected: gateway auth token mismatch.",
          startedAt: new Date("2026-04-16T10:00:00.000Z"),
          updatedAt: new Date("2026-04-16T10:00:05.000Z"),
          events: [],
        },
      ],
    },
    en,
  );

  assert.equal(detail.session.status, SessionStatus.ACTIVE);
  assert.equal(detail.messages[0]?.role, MessageRole.USER);
  assert.equal(detail.runHistory[0]?.errorMessage, en.errors.gatewayAuthFailed);
  assert.equal(detail.runHistory[0]?.errorDiagnostic, "[openclaw] connect rejected: gateway auth token mismatch.");
});
