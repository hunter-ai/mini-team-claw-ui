import { UserRole } from "@prisma/client";
import { z } from "zod";
import type { Dictionary } from "@/lib/i18n/dictionary";

const baseCreateUserSchema = z.object({
  username: z.string(),
  password: z.string(),
  openclawAgentId: z.string(),
  role: z.enum([UserRole.ADMIN, UserRole.MEMBER]).optional(),
});

export type CreateUserFieldErrors = Partial<{
  username: string;
  password: string;
  openclawAgentId: string;
}>;

export type CreateUserPayload = {
  username: string;
  password: string;
  openclawAgentId: string;
  role: UserRole;
};

export type CreateUserValidationResult =
  | { success: true; data: CreateUserPayload }
  | { success: false; error: string; fieldErrors: CreateUserFieldErrors };

export type PasswordFieldErrors = Partial<{
  password: string;
}>;

export type PasswordUpdateValidationResult =
  | { success: true; data: { password: string } }
  | { success: false; error: string; fieldErrors: PasswordFieldErrors };

export function normalizeOpenClawAgentId(value: string) {
  return value.trim().toLowerCase();
}

export function validateCreateUserInput(
  raw: unknown,
  messages: Pick<Dictionary, "users" | "auth">,
  options?: { includeRole?: boolean },
): CreateUserValidationResult {
  const payload = baseCreateUserSchema.safeParse(raw);
  if (!payload.success) {
    return {
      success: false,
      error: messages.auth.invalidPayload,
      fieldErrors: inferFieldErrorsFromShape(raw, messages),
    };
  }

  const username = payload.data.username.trim();
  const password = payload.data.password;
  const openclawAgentId = normalizeOpenClawAgentId(payload.data.openclawAgentId);
  const role = options?.includeRole ? payload.data.role ?? UserRole.MEMBER : UserRole.ADMIN;
  const fieldErrors: CreateUserFieldErrors = {};

  if (username.length < 3) {
    fieldErrors.username = messages.users.usernameTooShort;
  }

  if (password.length < 8) {
    fieldErrors.password = messages.users.passwordTooShort;
  }

  if (!openclawAgentId) {
    fieldErrors.openclawAgentId = messages.users.agentIdRequired;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      success: false,
      error: fieldErrors.username ?? fieldErrors.password ?? fieldErrors.openclawAgentId ?? messages.auth.invalidPayload,
      fieldErrors,
    };
  }

  return {
    success: true,
    data: {
      username,
      password,
      openclawAgentId,
      role,
    },
  };
}

export function validatePasswordUpdateInput(
  raw: unknown,
  messages: Pick<Dictionary, "users" | "auth">,
): PasswordUpdateValidationResult {
  if (!raw || typeof raw !== "object") {
    return {
      success: false,
      error: messages.auth.invalidPayload,
      fieldErrors: {},
    };
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.password !== "string") {
    return {
      success: false,
      error: messages.auth.invalidPayload,
      fieldErrors: {},
    };
  }

  if (candidate.password.length < 8) {
    return {
      success: false,
      error: messages.users.passwordTooShort,
      fieldErrors: { password: messages.users.passwordTooShort },
    };
  }

  return {
    success: true,
    data: {
      password: candidate.password,
    },
  };
}

function inferFieldErrorsFromShape(
  raw: unknown,
  messages: Pick<Dictionary, "users">,
): CreateUserFieldErrors {
  const fieldErrors: CreateUserFieldErrors = {};

  if (!raw || typeof raw !== "object") {
    return fieldErrors;
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.username !== "string") {
    fieldErrors.username = messages.users.usernameTooShort;
  }

  if (typeof candidate.password !== "string") {
    fieldErrors.password = messages.users.passwordTooShort;
  }

  if (typeof candidate.openclawAgentId !== "string") {
    fieldErrors.openclawAgentId = messages.users.agentIdRequired;
  }

  return fieldErrors;
}
