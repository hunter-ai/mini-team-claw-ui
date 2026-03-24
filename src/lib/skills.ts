import type { Prisma } from "@prisma/client";
import { OpenClawGatewayClient } from "@/lib/openclaw/gateway";
import type { GatewaySkillListItem } from "@/lib/openclaw/gateway";

export type SelectedSkillSnapshot = {
  key: string;
  name: string;
  source: string;
  bundled: boolean;
};

export type SkillSelectionErrorCode = "not_found" | "disabled" | "blocked" | "missing";

export async function listGatewaySkills() {
  const client = new OpenClawGatewayClient();

  try {
    await client.connect();
    return await client.listSkills();
  } finally {
    await client.close();
  }
}

export function toSelectedSkillSnapshot(skill: GatewaySkillListItem): SelectedSkillSnapshot {
  return {
    key: skill.key,
    name: skill.name,
    source: skill.source,
    bundled: skill.bundled,
  };
}

export function resolveSelectedSkillSnapshots(args: {
  skillKeys: string[];
  skills: GatewaySkillListItem[];
}) {
  const orderedSkillKeys: string[] = [];
  const seen = new Set<string>();

  for (const skillKey of args.skillKeys) {
    if (!seen.has(skillKey)) {
      seen.add(skillKey);
      orderedSkillKeys.push(skillKey);
    }
  }

  const skillsByKey = new Map(args.skills.map((skill) => [skill.key, skill]));
  const selectedSkills: SelectedSkillSnapshot[] = [];

  for (const skillKey of orderedSkillKeys) {
    const skill = skillsByKey.get(skillKey);

    if (!skill) {
      return {
        ok: false as const,
        code: "not_found" as SkillSelectionErrorCode,
        key: skillKey,
      };
    }

    if (skill.disabled) {
      return {
        ok: false as const,
        code: "disabled" as SkillSelectionErrorCode,
        key: skillKey,
      };
    }

    if (skill.blockedByAllowlist) {
      return {
        ok: false as const,
        code: "blocked" as SkillSelectionErrorCode,
        key: skillKey,
      };
    }

    if (!skill.eligible) {
      return {
        ok: false as const,
        code: "missing" as SkillSelectionErrorCode,
        key: skillKey,
      };
    }

    selectedSkills.push(toSelectedSkillSnapshot(skill));
  }

  return {
    ok: true as const,
    selectedSkills,
  };
}

function asRecord(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

export function parseSelectedSkillsJson(value: Prisma.JsonValue | null): SelectedSkillSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = asRecord(item as Prisma.JsonValue);
      const key = readString(record?.key);
      const name = readString(record?.name);
      const source = readString(record?.source);

      if (!key || !name || !source) {
        return null;
      }

      return {
        key,
        name,
        source,
        bundled: readBoolean(record?.bundled),
      } satisfies SelectedSkillSnapshot;
    })
    .filter((item): item is SelectedSkillSnapshot => item !== null);
}
