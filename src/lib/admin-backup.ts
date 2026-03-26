import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import packageJson from "../../package.json";
import { ChatRunStatus, MessageRole, Prisma, SessionStatus, UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const BACKUP_FORMAT = "mini-team-claw-backup" as const;
const BACKUP_SCHEMA_VERSION = 1 as const;
const BACKUP_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONVERSATION_SHARD_BYTES = 5 * 1024 * 1024;
const BACKUP_JOBS_DIR = path.join(os.tmpdir(), "mini-team-claw-backups");
const INCOMPLETE_RUN_IMPORT_MESSAGE = "Imported from backup after incomplete run";

const isoDateTimeSchema = z.string().datetime();

const userRecordSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  role: z.enum(UserRole),
  openclawAgentId: z.string().min(1),
  isActive: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const identityRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  provider: z.string().min(1),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().nullable(),
  preferredUsername: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const sessionRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  openclawSessionId: z.string().min(1),
  title: z.string(),
  isTitleManuallySet: z.boolean(),
  status: z.enum(SessionStatus),
  lastMessageAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const messageRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(MessageRole),
  content: z.string(),
  attachmentIds: z.array(z.string()),
  selectedSkillsJson: z.unknown().nullable().optional(),
  createdAt: isoDateTimeSchema,
});

const runRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  clientRequestId: z.string().min(1),
  userMessageId: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
  gatewayRunId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  status: z.enum(ChatRunStatus),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable(),
  lastEventSeq: z.number().int(),
  draftAssistantContent: z.string(),
  errorMessage: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const runEventRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int(),
  type: z.string().min(1),
  delta: z.string().nullable(),
  payloadJson: z.unknown().nullable().optional(),
  createdAt: isoDateTimeSchema,
});

const envelopeBaseSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  kind: z.enum(["users", "conversations"]),
  exportedAt: isoDateTimeSchema,
  sourceAppVersion: z.string().min(1),
});

const userBackupSchema = envelopeBaseSchema.extend({
  kind: z.literal("users"),
  users: z.array(userRecordSchema),
  identities: z.array(identityRecordSchema),
});

const conversationBackupSchema = envelopeBaseSchema.extend({
  kind: z.literal("conversations"),
  sessions: z.array(sessionRecordSchema),
  messages: z.array(messageRecordSchema),
  runs: z.array(runRecordSchema),
  runEvents: z.array(runEventRecordSchema),
});

const conversationCountSchema = z.object({
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  runEvents: z.number().int().nonnegative(),
});

const shardManifestEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  fileName: z.string().min(1),
  sessionIds: z.array(z.string()),
  counts: conversationCountSchema,
  sha256: z.string().length(64),
});

const conversationManifestSchema = envelopeBaseSchema.extend({
  kind: z.literal("conversations"),
  layout: z.literal("manifest"),
  exportId: z.string().min(1),
  shardStrategy: z.literal("session"),
  targetShardBytes: z.number().int().positive(),
  shardCount: z.number().int().positive(),
  totals: conversationCountSchema,
  warnings: z.array(z.string()),
  shards: z.array(shardManifestEntrySchema),
});

const conversationShardSchema = envelopeBaseSchema.extend({
  kind: z.literal("conversations"),
  layout: z.literal("shard"),
  exportId: z.string().min(1),
  shardIndex: z.number().int().nonnegative(),
  shardCount: z.number().int().positive(),
  sessionIds: z.array(z.string()),
  sessions: z.array(sessionRecordSchema),
  messages: z.array(messageRecordSchema),
  runs: z.array(runRecordSchema),
  runEvents: z.array(runEventRecordSchema),
});

const backupDocumentSchema = z.union([
  userBackupSchema,
  conversationManifestSchema,
  conversationShardSchema,
  conversationBackupSchema,
]);

export type UserBackupEnvelope = z.infer<typeof userBackupSchema>;
export type ConversationBackupEnvelope = z.infer<typeof conversationBackupSchema>;
export type ConversationBackupManifest = z.infer<typeof conversationManifestSchema>;
export type ConversationBackupShard = z.infer<typeof conversationShardSchema>;
export type BackupEnvelope = UserBackupEnvelope | ConversationBackupEnvelope;
export type BackupDocument = z.infer<typeof backupDocumentSchema>;
export type ConversationCounts = z.infer<typeof conversationCountSchema>;

type ConversationExportRecords = {
  sessions: ConversationBackupEnvelope["sessions"];
  messages: ConversationBackupEnvelope["messages"];
  runs: ConversationBackupEnvelope["runs"];
  runEvents: ConversationBackupEnvelope["runEvents"];
};

type ConversationSessionBundle = {
  sessionId: string;
  sessions: ConversationBackupEnvelope["sessions"];
  messages: ConversationBackupEnvelope["messages"];
  runs: ConversationBackupEnvelope["runs"];
  runEvents: ConversationBackupEnvelope["runEvents"];
  estimatedBytes: number;
};

type ExistingIdMap = {
  users: Set<string>;
  identities: Set<string>;
  sessions: Set<string>;
  messages: Set<string>;
  runs: Set<string>;
  runEvents: Set<string>;
};

type UploadFileInput = {
  name: string;
  text: string;
};

type ConversationImportPackage = {
  manifest: ConversationBackupManifest;
  shards: ConversationBackupShard[];
  warnings: string[];
};

type ConversationExportJobFile = {
  fileName: string;
  kind: "manifest" | "shard";
  sizeBytes: number;
  downloadPath: string;
};

export type ConversationExportJobResult = {
  jobId: string;
  exportId: string;
  exportedAt: string;
  shardCount: number;
  warnings: string[];
  files: ConversationExportJobFile[];
};

export type BackupImportSummary = {
  kind: "users" | "conversations";
  schemaVersion: number;
  counts: Record<string, { created: number; updated: number }>;
  warnings: string[];
  normalizedRuns: number;
};

function getSourceAppVersion() {
  return packageJson.version || "0.0.0";
}

function createCountMap() {
  return {
    users: { created: 0, updated: 0 },
    identities: { created: 0, updated: 0 },
    sessions: { created: 0, updated: 0 },
    messages: { created: 0, updated: 0 },
    runs: { created: 0, updated: 0 },
    runEvents: { created: 0, updated: 0 },
  };
}

function createConversationCounts(
  input: Pick<ConversationExportRecords, "sessions" | "messages" | "runs" | "runEvents">,
): ConversationCounts {
  return {
    sessions: input.sessions.length,
    messages: input.messages.length,
    runs: input.runs.length,
    runEvents: input.runEvents.length,
  };
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function validateUniqueIds<T extends { id: string }>(items: T[], label: string) {
  if (items.length !== dedupeById(items).length) {
    throw new Error(`Duplicate ${label} ids found in backup.`);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toDate(value: string | null) {
  return value ? new Date(value) : null;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}

function sanitizeDownloadFileName(fileName: string) {
  return path.basename(fileName);
}

function createConversationBaseFilename(exportedAt: string) {
  return `mtc-backup-conversations-v${BACKUP_SCHEMA_VERSION}-${exportedAt.replaceAll(":", "-")}`;
}

function validateUserBackup(input: UserBackupEnvelope) {
  validateUniqueIds(input.users, "user");
  validateUniqueIds(input.identities, "identity");

  const userIds = new Set(input.users.map((user) => user.id));
  for (const identity of input.identities) {
    if (!userIds.has(identity.userId)) {
      throw new Error(`Identity ${identity.id} references missing user ${identity.userId}.`);
    }
  }
}

async function validateConversationBackup(input: ConversationBackupEnvelope) {
  validateUniqueIds(input.sessions, "session");
  validateUniqueIds(input.messages, "message");
  validateUniqueIds(input.runs, "run");
  validateUniqueIds(input.runEvents, "run event");

  const sessionIds = new Set(input.sessions.map((session) => session.id));
  const messageIds = new Set(input.messages.map((message) => message.id));
  const runIds = new Set(input.runs.map((run) => run.id));
  const userIds = [...new Set(input.sessions.map((session) => session.userId))];

  const existingUsers = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true },
  });
  const existingUserIds = new Set(existingUsers.map((user) => user.id));

  for (const session of input.sessions) {
    if (!existingUserIds.has(session.userId)) {
      throw new Error(`Session ${session.id} references missing user ${session.userId} in the database.`);
    }
  }

  for (const message of input.messages) {
    if (!sessionIds.has(message.sessionId)) {
      throw new Error(`Message ${message.id} references missing session ${message.sessionId}.`);
    }
  }

  for (const run of input.runs) {
    if (!sessionIds.has(run.sessionId)) {
      throw new Error(`Run ${run.id} references missing session ${run.sessionId}.`);
    }
    if (!existingUserIds.has(run.userId)) {
      throw new Error(`Run ${run.id} references missing user ${run.userId} in the database.`);
    }
    if (run.userMessageId && !messageIds.has(run.userMessageId)) {
      throw new Error(`Run ${run.id} references missing userMessageId ${run.userMessageId}.`);
    }
    if (run.assistantMessageId && !messageIds.has(run.assistantMessageId)) {
      throw new Error(`Run ${run.id} references missing assistantMessageId ${run.assistantMessageId}.`);
    }
  }

  for (const event of input.runEvents) {
    if (!runIds.has(event.runId)) {
      throw new Error(`Run event ${event.id} references missing run ${event.runId}.`);
    }
  }
}

function validateManifest(manifest: ConversationBackupManifest) {
  validateUniqueIds(
    manifest.shards.map((entry) => ({ id: String(entry.index) })),
    "manifest shard",
  );
  if (manifest.shards.length !== manifest.shardCount) {
    throw new Error("Manifest shardCount does not match shard list length.");
  }
}

function serializeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function mergeImportCounts(
  target: BackupImportSummary["counts"],
  source: BackupImportSummary["counts"],
) {
  for (const [key, value] of Object.entries(source)) {
    target[key] ??= { created: 0, updated: 0 };
    target[key].created += value.created;
    target[key].updated += value.updated;
  }
}

function estimateConversationBundleBytes(bundle: Omit<ConversationSessionBundle, "estimatedBytes" | "sessionId">) {
  return Buffer.byteLength(
    JSON.stringify({
      sessions: bundle.sessions,
      messages: bundle.messages,
      runs: bundle.runs,
      runEvents: bundle.runEvents,
    }),
    "utf8",
  );
}

function buildConversationSessionBundles(records: ConversationExportRecords): ConversationSessionBundle[] {
  const messagesBySession = new Map<string, ConversationBackupEnvelope["messages"]>();
  const runsBySession = new Map<string, ConversationBackupEnvelope["runs"]>();
  const eventsByRun = new Map<string, ConversationBackupEnvelope["runEvents"]>();

  for (const message of records.messages) {
    const current = messagesBySession.get(message.sessionId) ?? [];
    current.push(message);
    messagesBySession.set(message.sessionId, current);
  }

  for (const run of records.runs) {
    const current = runsBySession.get(run.sessionId) ?? [];
    current.push(run);
    runsBySession.set(run.sessionId, current);
  }

  for (const event of records.runEvents) {
    const current = eventsByRun.get(event.runId) ?? [];
    current.push(event);
    eventsByRun.set(event.runId, current);
  }

  return records.sessions.map((session) => {
    const runs = runsBySession.get(session.id) ?? [];
    const runEvents = runs.flatMap((run) => eventsByRun.get(run.id) ?? []);
    const messages = messagesBySession.get(session.id) ?? [];
    const data = {
      sessions: [session],
      messages,
      runs,
      runEvents,
    };

    return {
      sessionId: session.id,
      ...data,
      estimatedBytes: estimateConversationBundleBytes(data),
    };
  });
}

export function buildConversationShardDocuments(
  records: ConversationExportRecords,
  options?: {
    exportedAt?: string;
    exportId?: string;
    targetShardBytes?: number;
    sourceAppVersion?: string;
  },
): { manifest: ConversationBackupManifest; shards: ConversationBackupShard[] } {
  const exportedAt = options?.exportedAt ?? new Date().toISOString();
  const exportId = options?.exportId ?? randomUUID();
  const targetShardBytes = options?.targetShardBytes ?? DEFAULT_CONVERSATION_SHARD_BYTES;
  const sourceAppVersion = options?.sourceAppVersion ?? getSourceAppVersion();
  const bundles = buildConversationSessionBundles(records);
  const warnings: string[] = [];
  const grouped: ConversationSessionBundle[][] = [];
  let current: ConversationSessionBundle[] = [];
  let currentBytes = 0;

  for (const bundle of bundles) {
    if (bundle.estimatedBytes > targetShardBytes) {
      warnings.push(`Session ${bundle.sessionId} exceeds the shard target and was exported alone.`);
    }

    const shouldSplit = current.length > 0 && currentBytes + bundle.estimatedBytes > targetShardBytes;
    if (shouldSplit) {
      grouped.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(bundle);
    currentBytes += bundle.estimatedBytes;
  }

  if (current.length > 0 || grouped.length === 0) {
    grouped.push(current);
  }

  const baseFileName = createConversationBaseFilename(exportedAt);

  const shards = grouped.map((bundleGroup, index) => {
    const sessions = bundleGroup.flatMap((bundle) => bundle.sessions);
    const messages = bundleGroup.flatMap((bundle) => bundle.messages);
    const runs = bundleGroup.flatMap((bundle) => bundle.runs);
    const runEvents = bundleGroup.flatMap((bundle) => bundle.runEvents);
    return {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: "conversations",
      layout: "shard",
      exportId,
      exportedAt,
      sourceAppVersion,
      shardIndex: index,
      shardCount: grouped.length,
      sessionIds: bundleGroup.map((bundle) => bundle.sessionId),
      sessions,
      messages,
      runs,
      runEvents,
    } satisfies ConversationBackupShard;
  });

  const manifest = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: "conversations",
    layout: "manifest",
    exportId,
    exportedAt,
    sourceAppVersion,
    shardStrategy: "session",
    targetShardBytes,
    shardCount: shards.length,
    totals: createConversationCounts(records),
    warnings,
    shards: shards.map((shard) => {
      const fileName = `${baseFileName}-part-${String(shard.shardIndex + 1).padStart(3, "0")}.json`;
      const content = serializeJson(shard);
      return {
        index: shard.shardIndex,
        fileName,
        sessionIds: shard.sessionIds,
        counts: createConversationCounts(shard),
        sha256: sha256(content),
      };
    }),
  } satisfies ConversationBackupManifest;

  return { manifest, shards };
}

async function fetchConversationExportRecords(): Promise<ConversationExportRecords> {
  const [sessions, messages, runs, runEvents] = await Promise.all([
    prisma.chatSession.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        agentId: true,
        openclawSessionId: true,
        title: true,
        isTitleManuallySet: true,
        status: true,
        lastMessageAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.chatMessageCache.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        sessionId: true,
        role: true,
        content: true,
        selectedSkillsJson: true,
        createdAt: true,
      },
    }),
    prisma.chatRun.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        sessionId: true,
        userId: true,
        clientRequestId: true,
        userMessageId: true,
        assistantMessageId: true,
        gatewayRunId: true,
        idempotencyKey: true,
        status: true,
        startedAt: true,
        endedAt: true,
        lastEventSeq: true,
        draftAssistantContent: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.chatRunEvent.findMany({
      orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
      select: {
        id: true,
        runId: true,
        seq: true,
        type: true,
        delta: true,
        payloadJson: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    sessions: sessions.map((session) => ({
      ...session,
      lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    })),
    messages: messages.map((message) => ({
      ...message,
      attachmentIds: [],
      selectedSkillsJson: message.selectedSkillsJson,
      createdAt: message.createdAt.toISOString(),
    })),
    runs: runs.map((run) => ({
      ...run,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    })),
    runEvents: runEvents.map((event) => ({
      ...event,
      payloadJson: event.payloadJson,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

async function ensureBackupJobsDir() {
  await mkdir(BACKUP_JOBS_DIR, { recursive: true });
}

async function cleanupExpiredBackupJobs() {
  await ensureBackupJobsDir();
  const entries = await readdir(BACKUP_JOBS_DIR, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const entryPath = path.join(BACKUP_JOBS_DIR, entry.name);
        const details = await stat(entryPath).catch(() => null);
        if (details && now - details.mtimeMs > BACKUP_JOB_TTL_MS) {
          await rm(entryPath, { recursive: true, force: true });
        }
      }),
  );
}

function getJobDir(jobId: string) {
  return path.join(BACKUP_JOBS_DIR, jobId);
}

export async function getBackupJobFile(jobId: string, fileName: string) {
  await cleanupExpiredBackupJobs();
  const safeFileName = sanitizeDownloadFileName(fileName);
  if (safeFileName !== fileName) {
    throw new Error("Invalid backup file name.");
  }

  const filePath = path.join(getJobDir(jobId), safeFileName);
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (!content) {
    throw new Error("Backup file not found.");
  }

  return {
    fileName: safeFileName,
    content,
  };
}

export function createBackupFilename(kind: BackupEnvelope["kind"], exportedAt: string) {
  const timestamp = exportedAt.replaceAll(":", "-");
  return `mtc-backup-${kind}-v${BACKUP_SCHEMA_VERSION}-${timestamp}.json`;
}

export async function exportUsersBackup(): Promise<UserBackupEnvelope> {
  const [users, identities] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        username: true,
        passwordHash: true,
        role: true,
        openclawAgentId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.userIdentity.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        provider: true,
        issuer: true,
        subject: true,
        email: true,
        preferredUsername: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const exportedAt = new Date().toISOString();

  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: "users",
    exportedAt,
    sourceAppVersion: getSourceAppVersion(),
    users: users.map((user) => ({
      ...user,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    })),
    identities: identities.map((identity) => ({
      ...identity,
      createdAt: identity.createdAt.toISOString(),
      updatedAt: identity.updatedAt.toISOString(),
    })),
  };
}

export async function createConversationExportJob(): Promise<ConversationExportJobResult> {
  await cleanupExpiredBackupJobs();

  const records = await fetchConversationExportRecords();
  const exportedAt = new Date().toISOString();
  const exportId = randomUUID();
  const jobId = randomUUID();
  const jobDir = getJobDir(jobId);
  const { manifest, shards } = buildConversationShardDocuments(records, {
    exportedAt,
    exportId,
    targetShardBytes: DEFAULT_CONVERSATION_SHARD_BYTES,
  });

  const baseFileName = createConversationBaseFilename(exportedAt);
  const manifestFileName = `${baseFileName}-manifest.json`;

  await mkdir(jobDir, { recursive: true });

  const files: ConversationExportJobFile[] = [];

  const manifestContent = serializeJson(manifest);
  await writeFile(path.join(jobDir, manifestFileName), manifestContent, "utf8");
  files.push({
    fileName: manifestFileName,
    kind: "manifest",
    sizeBytes: Buffer.byteLength(manifestContent, "utf8"),
    downloadPath: `/api/admin/backups/export/jobs/${jobId}/files/${encodeURIComponent(manifestFileName)}`,
  });

  for (const shard of shards) {
    const fileName = manifest.shards[shard.shardIndex]?.fileName;
    if (!fileName) {
      throw new Error(`Missing manifest entry for shard ${shard.shardIndex}.`);
    }
    const content = serializeJson(shard);
    await writeFile(path.join(jobDir, fileName), content, "utf8");
    files.push({
      fileName,
      kind: "shard",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      downloadPath: `/api/admin/backups/export/jobs/${jobId}/files/${encodeURIComponent(fileName)}`,
    });
  }

  return {
    jobId,
    exportId,
    exportedAt,
    shardCount: manifest.shardCount,
    warnings: manifest.warnings,
    files,
  };
}

export function parseBackupDocument(raw: unknown): BackupDocument {
  const parsed = backupDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid backup payload.");
  }

  if (parsed.data.kind === "users") {
    validateUserBackup(parsed.data);
  }

  if ("layout" in parsed.data && parsed.data.layout === "manifest") {
    validateManifest(parsed.data);
  }

  return parsed.data;
}

export function parseBackupEnvelope(raw: unknown): BackupEnvelope {
  const parsed = parseBackupDocument(raw);
  if ("layout" in parsed) {
    throw new Error("Backup payload must be a single importable envelope.");
  }
  return parsed;
}

async function collectExistingIds(
  tx: Prisma.TransactionClient,
  input: BackupEnvelope,
): Promise<ExistingIdMap> {
  const [users, identities, sessions, messages, runs, runEvents] = await Promise.all([
    input.kind === "users" && input.users.length
      ? tx.user.findMany({ where: { id: { in: input.users.map((item) => item.id) } }, select: { id: true } })
      : [],
    input.kind === "users" && input.identities.length
      ? tx.userIdentity.findMany({
          where: { id: { in: input.identities.map((item) => item.id) } },
          select: { id: true },
        })
      : [],
    input.kind === "conversations" && input.sessions.length
      ? tx.chatSession.findMany({
          where: { id: { in: input.sessions.map((item) => item.id) } },
          select: { id: true },
        })
      : [],
    input.kind === "conversations" && input.messages.length
      ? tx.chatMessageCache.findMany({
          where: { id: { in: input.messages.map((item) => item.id) } },
          select: { id: true },
        })
      : [],
    input.kind === "conversations" && input.runs.length
      ? tx.chatRun.findMany({
          where: { id: { in: input.runs.map((item) => item.id) } },
          select: { id: true },
        })
      : [],
    input.kind === "conversations" && input.runEvents.length
      ? tx.chatRunEvent.findMany({
          where: { id: { in: input.runEvents.map((item) => item.id) } },
          select: { id: true },
        })
      : [],
  ]);

  return {
    users: new Set(users.map((item) => item.id)),
    identities: new Set(identities.map((item) => item.id)),
    sessions: new Set(sessions.map((item) => item.id)),
    messages: new Set(messages.map((item) => item.id)),
    runs: new Set(runs.map((item) => item.id)),
    runEvents: new Set(runEvents.map((item) => item.id)),
  };
}

export function normalizeImportedConversationRun(
  run: ConversationBackupEnvelope["runs"][number],
  importedAt = new Date(),
) {
  if (run.status !== ChatRunStatus.STARTING && run.status !== ChatRunStatus.STREAMING) {
    return { run, normalized: false };
  }

  return {
    normalized: true,
    run: {
      ...run,
      status: ChatRunStatus.ABORTED,
      endedAt: importedAt.toISOString(),
      errorMessage: run.errorMessage ?? INCOMPLETE_RUN_IMPORT_MESSAGE,
    },
  };
}

async function importUsersBackupEnvelope(input: UserBackupEnvelope): Promise<BackupImportSummary> {
  validateUserBackup(input);
  const counts = createCountMap();

  await prisma.$transaction(async (tx) => {
    const existingIds = await collectExistingIds(tx, input);
    const newUsers = input.users.filter((user) => !existingIds.users.has(user.id));
    const existingUsers = input.users.filter((user) => existingIds.users.has(user.id));
    const newIdentities = input.identities.filter((identity) => !existingIds.identities.has(identity.id));
    const existingIdentities = input.identities.filter((identity) => existingIds.identities.has(identity.id));

    if (newUsers.length) {
      await tx.user.createMany({
        data: newUsers.map((user) => ({
          id: user.id,
          username: user.username,
          passwordHash: user.passwordHash,
          role: user.role,
          openclawAgentId: user.openclawAgentId,
          isActive: user.isActive,
          createdAt: new Date(user.createdAt),
          updatedAt: new Date(user.updatedAt),
        })),
      });
    }

    for (const user of existingUsers) {
      await tx.user.update({
        where: { id: user.id },
        data: {
          username: user.username,
          passwordHash: user.passwordHash,
          role: user.role,
          openclawAgentId: user.openclawAgentId,
          isActive: user.isActive,
          createdAt: new Date(user.createdAt),
          updatedAt: new Date(user.updatedAt),
        },
      });
    }

    if (newIdentities.length) {
      await tx.userIdentity.createMany({
        data: newIdentities.map((identity) => ({
          id: identity.id,
          userId: identity.userId,
          provider: identity.provider,
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email,
          preferredUsername: identity.preferredUsername,
          createdAt: new Date(identity.createdAt),
          updatedAt: new Date(identity.updatedAt),
        })),
      });
    }

    for (const identity of existingIdentities) {
      await tx.userIdentity.update({
        where: { id: identity.id },
        data: {
          userId: identity.userId,
          provider: identity.provider,
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email,
          preferredUsername: identity.preferredUsername,
          createdAt: new Date(identity.createdAt),
          updatedAt: new Date(identity.updatedAt),
        },
      });
    }

    counts.users.created += newUsers.length;
    counts.users.updated += existingUsers.length;
    counts.identities.created += newIdentities.length;
    counts.identities.updated += existingIdentities.length;
  }, { timeout: 60000, maxWait: 10000 });

  return {
    kind: "users",
    schemaVersion: input.schemaVersion,
    counts,
    warnings: [],
    normalizedRuns: 0,
  };
}

async function importConversationBackupEnvelope(input: ConversationBackupEnvelope): Promise<BackupImportSummary> {
  await validateConversationBackup(input);
  const counts = createCountMap();
  const warnings: string[] = [];
  let normalizedRuns = 0;
  const importedAt = new Date();
  const normalizedRunsById = new Map(
    input.runs.map((run) => {
      const normalized = normalizeImportedConversationRun(run, importedAt);
      if (normalized.normalized) {
        normalizedRuns += 1;
      }
      return [run.id, normalized.run];
    }),
  );

  await prisma.$transaction(async (tx) => {
    const existingIds = await collectExistingIds(tx, input);

    const newSessions = input.sessions.filter((session) => !existingIds.sessions.has(session.id));
    const existingSessions = input.sessions.filter((session) => existingIds.sessions.has(session.id));
    const newMessages = input.messages.filter((message) => !existingIds.messages.has(message.id));
    const existingMessages = input.messages.filter((message) => existingIds.messages.has(message.id));
    const normalizedRunsList = input.runs.map((run) => normalizedRunsById.get(run.id) ?? run);
    const newRuns = normalizedRunsList.filter((run) => !existingIds.runs.has(run.id));
    const existingRuns = normalizedRunsList.filter((run) => existingIds.runs.has(run.id));
    const newRunEvents = input.runEvents.filter((event) => !existingIds.runEvents.has(event.id));
    const existingRunEvents = input.runEvents.filter((event) => existingIds.runEvents.has(event.id));

    if (newSessions.length) {
      await tx.chatSession.createMany({
        data: newSessions.map((session) => ({
          id: session.id,
          userId: session.userId,
          agentId: session.agentId,
          openclawSessionId: session.openclawSessionId,
          title: session.title,
          isTitleManuallySet: session.isTitleManuallySet,
          status: session.status,
          lastMessageAt: toDate(session.lastMessageAt),
          createdAt: new Date(session.createdAt),
          updatedAt: new Date(session.updatedAt),
        })),
      });
    }

    for (const session of existingSessions) {
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          userId: session.userId,
          agentId: session.agentId,
          openclawSessionId: session.openclawSessionId,
          title: session.title,
          isTitleManuallySet: session.isTitleManuallySet,
          status: session.status,
          lastMessageAt: toDate(session.lastMessageAt),
          createdAt: new Date(session.createdAt),
          updatedAt: new Date(session.updatedAt),
        },
      });
    }

    if (newMessages.length) {
      await tx.chatMessageCache.createMany({
        data: newMessages.map((message) => ({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          attachmentIds: [],
          selectedSkillsJson: toPrismaJson(message.selectedSkillsJson ?? null),
          createdAt: new Date(message.createdAt),
        })),
      });
    }

    for (const message of existingMessages) {
      await tx.chatMessageCache.update({
        where: { id: message.id },
        data: {
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          attachmentIds: [],
          selectedSkillsJson: toPrismaJson(message.selectedSkillsJson ?? null),
          createdAt: new Date(message.createdAt),
        },
      });
    }

    if (newRuns.length) {
      await tx.chatRun.createMany({
        data: newRuns.map((run) => ({
          id: run.id,
          sessionId: run.sessionId,
          userId: run.userId,
          clientRequestId: run.clientRequestId,
          userMessageId: run.userMessageId,
          assistantMessageId: run.assistantMessageId,
          gatewayRunId: run.gatewayRunId,
          idempotencyKey: run.idempotencyKey,
          status: run.status,
          startedAt: new Date(run.startedAt),
          endedAt: toDate(run.endedAt),
          lastEventSeq: run.lastEventSeq,
          draftAssistantContent: run.draftAssistantContent,
          errorMessage: run.errorMessage,
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt),
        })),
      });
    }

    for (const run of existingRuns) {
      await tx.chatRun.update({
        where: { id: run.id },
        data: {
          sessionId: run.sessionId,
          userId: run.userId,
          clientRequestId: run.clientRequestId,
          userMessageId: run.userMessageId,
          assistantMessageId: run.assistantMessageId,
          gatewayRunId: run.gatewayRunId,
          idempotencyKey: run.idempotencyKey,
          status: run.status,
          startedAt: new Date(run.startedAt),
          endedAt: toDate(run.endedAt),
          lastEventSeq: run.lastEventSeq,
          draftAssistantContent: run.draftAssistantContent,
          errorMessage: run.errorMessage,
          createdAt: new Date(run.createdAt),
          updatedAt: new Date(run.updatedAt),
        },
      });
    }

    if (newRunEvents.length) {
      await tx.chatRunEvent.createMany({
        data: newRunEvents.map((event) => ({
          id: event.id,
          runId: event.runId,
          seq: event.seq,
          type: event.type,
          delta: event.delta,
          payloadJson: toPrismaJson(event.payloadJson ?? null),
          createdAt: new Date(event.createdAt),
        })),
      });
    }

    for (const event of existingRunEvents) {
      await tx.chatRunEvent.update({
        where: { id: event.id },
        data: {
          runId: event.runId,
          seq: event.seq,
          type: event.type,
          delta: event.delta,
          payloadJson: toPrismaJson(event.payloadJson ?? null),
          createdAt: new Date(event.createdAt),
        },
      });
    }

    counts.sessions.created += newSessions.length;
    counts.sessions.updated += existingSessions.length;
    counts.messages.created += newMessages.length;
    counts.messages.updated += existingMessages.length;
    counts.runs.created += newRuns.length;
    counts.runs.updated += existingRuns.length;
    counts.runEvents.created += newRunEvents.length;
    counts.runEvents.updated += existingRunEvents.length;
  }, { timeout: 120000, maxWait: 10000 });

  if (normalizedRuns > 0) {
    warnings.push(`${normalizedRuns} incomplete runs were imported as ABORTED.`);
  }

  return {
    kind: "conversations",
    schemaVersion: input.schemaVersion,
    counts,
    warnings,
    normalizedRuns,
  };
}

export async function importBackupEnvelope(input: BackupEnvelope): Promise<BackupImportSummary> {
  return input.kind === "users" ? importUsersBackupEnvelope(input) : importConversationBackupEnvelope(input);
}

export function buildConversationImportPackage(files: UploadFileInput[]): ConversationImportPackage {
  const parsedFiles = files.map((file) => {
    const parsed = parseBackupDocument(JSON.parse(file.text) as unknown);
    return {
      name: file.name,
      text: file.text,
      checksum: sha256(file.text),
      parsed,
    };
  });

  const users = parsedFiles.filter((file) => file.parsed.kind === "users");
  if (users.length > 0) {
    throw new Error("Conversation package cannot include user backup files.");
  }

  const legacyConversation = parsedFiles.filter(
    (file) => file.parsed.kind === "conversations" && !("layout" in file.parsed),
  );
  if (legacyConversation.length > 0) {
    throw new Error("Legacy single-file conversation backups cannot be mixed with sharded imports.");
  }

  const manifests = parsedFiles.filter(
    (file): file is typeof file & { parsed: ConversationBackupManifest } =>
      file.parsed.kind === "conversations" && "layout" in file.parsed && file.parsed.layout === "manifest",
  );
  if (manifests.length !== 1) {
    throw new Error("Import requires exactly one conversation manifest file.");
  }

  const manifestEntry = manifests[0];
  const shards = parsedFiles.filter(
    (file): file is typeof file & { parsed: ConversationBackupShard } =>
      file.parsed.kind === "conversations" && "layout" in file.parsed && file.parsed.layout === "shard",
  );

  const shardMap = new Map(shards.map((shard) => [shard.name, shard]));
  const warnings: string[] = [...manifestEntry.parsed.warnings];

  if (parsedFiles.length !== manifestEntry.parsed.shards.length + 1) {
    throw new Error("Uploaded files do not exactly match the manifest and shard set.");
  }

  const orderedShards = manifestEntry.parsed.shards
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((entry) => {
      const shard = shardMap.get(entry.fileName);
      if (!shard) {
        throw new Error(`Missing shard file ${entry.fileName}.`);
      }
      if (shard.parsed.exportId !== manifestEntry.parsed.exportId) {
        throw new Error(`Shard ${entry.fileName} does not belong to export ${manifestEntry.parsed.exportId}.`);
      }
      if (shard.parsed.shardIndex !== entry.index) {
        throw new Error(`Shard ${entry.fileName} has an unexpected shard index.`);
      }
      if (shard.parsed.shardCount !== manifestEntry.parsed.shardCount) {
        throw new Error(`Shard ${entry.fileName} has an unexpected shard count.`);
      }
      if (shard.checksum !== entry.sha256) {
        throw new Error(`Shard ${entry.fileName} checksum mismatch.`);
      }
      return shard.parsed;
    });

  for (const shard of shards) {
    if (!manifestEntry.parsed.shards.some((entry) => entry.fileName === shard.name)) {
      throw new Error(`Shard file ${shard.name} is not referenced by the manifest.`);
    }
  }

  return {
    manifest: manifestEntry.parsed,
    shards: orderedShards,
    warnings,
  };
}

export async function importBackupFiles(files: UploadFileInput[]): Promise<BackupImportSummary> {
  if (files.length === 0) {
    throw new Error("No backup files uploaded.");
  }

  if (files.length === 1) {
    const single = parseBackupDocument(JSON.parse(files[0].text) as unknown);
    if ("layout" in single && single.layout === "manifest") {
      throw new Error("This manifest requires all shard files to be uploaded together.");
    }
    if ("layout" in single && single.layout === "shard") {
      throw new Error("Import the manifest file together with all shard files.");
    }
    return importBackupEnvelope(single);
  }

  const pkg = buildConversationImportPackage(files);
  const counts = createCountMap();
  const warnings = [...pkg.warnings];
  let normalizedRuns = 0;

  for (const shard of pkg.shards) {
    const summary = await importConversationBackupEnvelope({
      format: shard.format,
      schemaVersion: shard.schemaVersion,
      kind: "conversations",
      exportedAt: shard.exportedAt,
      sourceAppVersion: shard.sourceAppVersion,
      sessions: shard.sessions,
      messages: shard.messages,
      runs: shard.runs,
      runEvents: shard.runEvents,
    });
    mergeImportCounts(counts, summary.counts);
    warnings.push(...summary.warnings);
    normalizedRuns += summary.normalizedRuns;
  }

  return {
    kind: "conversations",
    schemaVersion: pkg.manifest.schemaVersion,
    counts,
    warnings,
    normalizedRuns,
  };
}
