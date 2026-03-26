import assert from "node:assert/strict";
import test from "node:test";
import { ChatRunStatus } from "@prisma/client";
import {
  buildConversationImportPackage,
  buildConversationShardDocuments,
  createBackupFilename,
  normalizeImportedConversationRun,
  parseBackupEnvelope,
} from "@/lib/admin-backup";

test("parseBackupEnvelope accepts users backup payloads", () => {
  const payload = parseBackupEnvelope({
    format: "mini-team-claw-backup",
    schemaVersion: 1,
    kind: "users",
    exportedAt: "2026-03-27T10:00:00.000Z",
    sourceAppVersion: "0.1.0",
    users: [
      {
        id: "user_1",
        username: "alice",
        passwordHash: "hash",
        role: "ADMIN",
        openclawAgentId: "agent_1",
        isActive: true,
        createdAt: "2026-03-27T10:00:00.000Z",
        updatedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
    identities: [
      {
        id: "identity_1",
        userId: "user_1",
        provider: "oidc",
        issuer: "issuer",
        subject: "subject",
        email: "alice@example.com",
        preferredUsername: "alice",
        createdAt: "2026-03-27T10:00:00.000Z",
        updatedAt: "2026-03-27T10:00:00.000Z",
      },
    ],
  });

  assert.equal(payload.kind, "users");
  assert.equal(payload.schemaVersion, 1);
});

test("parseBackupEnvelope rejects identity references to missing users", () => {
  assert.throws(
    () =>
      parseBackupEnvelope({
        format: "mini-team-claw-backup",
        schemaVersion: 1,
        kind: "users",
        exportedAt: "2026-03-27T10:00:00.000Z",
        sourceAppVersion: "0.1.0",
        users: [],
        identities: [
          {
            id: "identity_1",
            userId: "missing_user",
            provider: "oidc",
            issuer: "issuer",
            subject: "subject",
            email: null,
            preferredUsername: null,
            createdAt: "2026-03-27T10:00:00.000Z",
            updatedAt: "2026-03-27T10:00:00.000Z",
          },
        ],
      }),
    /references missing user/,
  );
});

test("normalizeImportedConversationRun converts incomplete runs to aborted", () => {
  const importedAt = new Date("2026-03-27T12:34:56.000Z");
  const result = normalizeImportedConversationRun(
    {
      id: "run_1",
      sessionId: "session_1",
      userId: "user_1",
      clientRequestId: "client_1",
      userMessageId: "message_1",
      assistantMessageId: null,
      gatewayRunId: null,
      idempotencyKey: "key_1",
      status: ChatRunStatus.STREAMING,
      startedAt: "2026-03-27T10:00:00.000Z",
      endedAt: null,
      lastEventSeq: 3,
      draftAssistantContent: "draft",
      errorMessage: null,
      createdAt: "2026-03-27T10:00:00.000Z",
      updatedAt: "2026-03-27T10:05:00.000Z",
    },
    importedAt,
  );

  assert.equal(result.normalized, true);
  assert.equal(result.run.status, ChatRunStatus.ABORTED);
  assert.equal(result.run.endedAt, importedAt.toISOString());
  assert.match(result.run.errorMessage ?? "", /Imported from backup/);
});

test("normalizeImportedConversationRun keeps completed runs unchanged", () => {
  const run = {
    id: "run_1",
    sessionId: "session_1",
    userId: "user_1",
    clientRequestId: "client_1",
    userMessageId: "message_1",
    assistantMessageId: "message_2",
    gatewayRunId: "gateway_1",
    idempotencyKey: "key_1",
    status: ChatRunStatus.COMPLETED,
    startedAt: "2026-03-27T10:00:00.000Z",
    endedAt: "2026-03-27T10:10:00.000Z",
    lastEventSeq: 8,
    draftAssistantContent: "done",
    errorMessage: null,
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedAt: "2026-03-27T10:10:00.000Z",
  } as const;

  const result = normalizeImportedConversationRun(run);

  assert.equal(result.normalized, false);
  assert.deepEqual(result.run, run);
});

test("createBackupFilename encodes kind and schema version", () => {
  assert.equal(
    createBackupFilename("conversations", "2026-03-27T12:34:56.000Z"),
    "mtc-backup-conversations-v1-2026-03-27T12-34-56.000Z.json",
  );
});

test("buildConversationShardDocuments keeps sessions intact across shards", () => {
  const result = buildConversationShardDocuments(
    {
      sessions: [
        {
          id: "session_1",
          userId: "user_1",
          agentId: "agent_1",
          openclawSessionId: "open_1",
          title: "Session 1",
          isTitleManuallySet: false,
          status: "ACTIVE",
          lastMessageAt: null,
          createdAt: "2026-03-27T10:00:00.000Z",
          updatedAt: "2026-03-27T10:00:00.000Z",
        },
        {
          id: "session_2",
          userId: "user_1",
          agentId: "agent_1",
          openclawSessionId: "open_2",
          title: "Session 2",
          isTitleManuallySet: false,
          status: "ACTIVE",
          lastMessageAt: null,
          createdAt: "2026-03-27T10:10:00.000Z",
          updatedAt: "2026-03-27T10:10:00.000Z",
        },
      ],
      messages: [
        {
          id: "message_1",
          sessionId: "session_1",
          role: "USER",
          content: "a".repeat(300),
          attachmentIds: [],
          selectedSkillsJson: null,
          createdAt: "2026-03-27T10:00:00.000Z",
        },
        {
          id: "message_2",
          sessionId: "session_2",
          role: "USER",
          content: "b".repeat(300),
          attachmentIds: [],
          selectedSkillsJson: null,
          createdAt: "2026-03-27T10:10:00.000Z",
        },
      ],
      runs: [],
      runEvents: [],
    },
    {
      exportedAt: "2026-03-27T10:00:00.000Z",
      exportId: "export_1",
      targetShardBytes: 250,
      sourceAppVersion: "0.1.0",
    },
  );

  assert.equal(result.manifest.shardCount, 2);
  assert.deepEqual(
    result.shards.map((shard) => shard.sessionIds),
    [["session_1"], ["session_2"]],
  );
});

test("buildConversationImportPackage rejects missing shards from manifest", () => {
  const { manifest } = buildConversationShardDocuments(
    {
      sessions: [
        {
          id: "session_1",
          userId: "user_1",
          agentId: "agent_1",
          openclawSessionId: "open_1",
          title: "Session 1",
          isTitleManuallySet: false,
          status: "ACTIVE",
          lastMessageAt: null,
          createdAt: "2026-03-27T10:00:00.000Z",
          updatedAt: "2026-03-27T10:00:00.000Z",
        },
      ],
      messages: [],
      runs: [],
      runEvents: [],
    },
    {
      exportedAt: "2026-03-27T10:00:00.000Z",
      exportId: "export_2",
      targetShardBytes: 1,
      sourceAppVersion: "0.1.0",
    },
  );

  assert.throws(
    () =>
      buildConversationImportPackage([
        {
          name: "manifest.json",
          text: JSON.stringify(manifest),
        },
      ]),
    /Uploaded files do not exactly match|Missing shard file/,
  );
});
