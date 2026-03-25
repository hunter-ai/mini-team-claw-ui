type JsonObject = Record<string, unknown>;

export type SessionContextUsage = {
  usedTokens: number;
  totalTokens: number;
  remainingTokens: number;
  usageRatio: number;
  provider: string | null;
  model: string | null;
};

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractJsonPayload(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

export function parseSessionContextUsage(rawText: string): SessionContextUsage | null {
  const parsed = extractJsonPayload(rawText);
  const payload = asRecord(parsed);
  const report = asRecord(payload?.report);
  const session = asRecord(payload?.session);
  const provider = readString(report?.provider);
  const model = readString(report?.model);
  const usedTokens =
    readNumber(session?.totalTokens) ??
    ((readNumber(session?.inputTokens) ?? 0) + (readNumber(session?.outputTokens) ?? 0));
  const totalTokens = readNumber(session?.contextTokens);

  if (usedTokens === null || totalTokens === null || totalTokens <= 0) {
    return null;
  }

  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  const usageRatio = Math.min(1, Math.max(0, usedTokens / totalTokens));

  return {
    usedTokens,
    totalTokens,
    remainingTokens,
    usageRatio,
    provider,
    model,
  };
}
