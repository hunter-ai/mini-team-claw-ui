import assert from "node:assert/strict";
import test from "node:test";
import en from "@/lib/i18n/dictionaries/en";
import zh from "@/lib/i18n/dictionaries/zh";
import {
  errorFromCode,
  inferErrorCode,
  localizeError,
  localizePersistedGatewayMessage,
} from "@/lib/user-facing-errors";

test("errorFromCode returns localized setup copy", () => {
  assert.equal(errorFromCode(en, "setup_not_complete").error, "Workspace setup is not complete yet.");
  assert.equal(errorFromCode(zh, "setup_not_complete").error, "工作区配置尚未完成。");
});

test("localizeError maps runtime config validation errors to user-facing copy", () => {
  assert.deepEqual(localizeError(en, new Error("Gateway credential is required")), {
    error: "Enter the Gateway credential before continuing.",
    errorCode: "gateway_token_required",
  });

  assert.deepEqual(localizeError(zh, new Error("Gateway URL must use ws:// or wss://")), {
    error: "OpenClaw 地址必须以 ws:// 或 wss:// 开头。",
    errorCode: "gateway_url_invalid",
  });
});

test("inferErrorCode recognizes backup and upload failures", () => {
  assert.equal(inferErrorCode(new Error("Backup file not found.")), "backup_file_missing");
  assert.equal(inferErrorCode(new Error("File exceeds MAX_UPLOAD_BYTES (4)")), "attachment_too_large");
  assert.equal(inferErrorCode(new Error("PAIRING_REQUIRED")), "gateway_pairing_required");
});

test("localizePersistedGatewayMessage rewrites persisted pairing messages for the current locale", () => {
  assert.equal(
    localizePersistedGatewayMessage(zh, "pairing_required", "[openclaw] connect rejected: device pairing required."),
    "这个工作区还需要在 OpenClaw 中完成审批。",
  );
  assert.equal(
    localizePersistedGatewayMessage(en, "failed", "[openclaw] connect rejected: gateway auth token mismatch."),
    "OpenClaw rejected the current gateway credential or device authorization.",
  );
  assert.equal(
    localizePersistedGatewayMessage(en, "failed", "[openclaw] connect rejected: gateway auth password mismatch."),
    "OpenClaw rejected the current gateway credential or device authorization.",
  );
});
