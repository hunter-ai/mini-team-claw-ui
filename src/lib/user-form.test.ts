import assert from "node:assert/strict";
import test from "node:test";
import { UserRole } from "@prisma/client";
import en from "@/lib/i18n/dictionaries/en";
import {
  normalizeOpenClawAgentId,
  validateCreateUserInput,
  validatePasswordUpdateInput,
} from "@/lib/user-form";

test("normalizeOpenClawAgentId trims and lowercases the value", () => {
  assert.equal(normalizeOpenClawAgentId("  Main-Agent  "), "main-agent");
});

test("validateCreateUserInput returns field-specific messages for invalid values", () => {
  const result = validateCreateUserInput(
    {
      username: "ab",
      password: "short",
      openclawAgentId: "   ",
      role: UserRole.ADMIN,
    },
    en,
    { includeRole: true },
  );

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }

  assert.equal(result.error, "Username must be at least 3 characters.");
  assert.deepEqual(result.fieldErrors, {
    username: "Username must be at least 3 characters.",
    password: "Password must be at least 8 characters.",
    openclawAgentId: "Agent ID is required.",
  });
});

test("validateCreateUserInput normalizes valid payloads", () => {
  const result = validateCreateUserInput(
    {
      username: "  alice  ",
      password: "password123",
      openclawAgentId: "  Main  ",
    },
    en,
  );

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.deepEqual(result.data, {
    username: "alice",
    password: "password123",
    openclawAgentId: "main",
    role: UserRole.ADMIN,
  });
});

test("validatePasswordUpdateInput returns a localized password error", () => {
  const result = validatePasswordUpdateInput({ password: "short" }, en);

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }

  assert.equal(result.error, "Password must be at least 8 characters.");
  assert.deepEqual(result.fieldErrors, {
    password: "Password must be at least 8 characters.",
  });
});

test("validatePasswordUpdateInput accepts a valid password", () => {
  const result = validatePasswordUpdateInput({ password: "password123" }, en);

  assert.equal(result.success, true);
  if (!result.success) {
    return;
  }

  assert.deepEqual(result.data, {
    password: "password123",
  });
});
