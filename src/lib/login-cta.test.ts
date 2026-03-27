import test from "node:test";
import assert from "node:assert/strict";
import { resolveLoginPrimaryAuthMethod } from "@/lib/login-cta";

test("resolveLoginPrimaryAuthMethod prefers oidc when available", () => {
  assert.equal(resolveLoginPrimaryAuthMethod(true), "oidc");
});

test("resolveLoginPrimaryAuthMethod falls back to password when oidc is unavailable", () => {
  assert.equal(resolveLoginPrimaryAuthMethod(false), "password");
});
