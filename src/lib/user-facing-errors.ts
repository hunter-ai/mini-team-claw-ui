import { ZodError } from "zod";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { OpenClawGatewayError } from "@/lib/openclaw/gateway";

export type UserFacingErrorCode =
  | "unknown"
  | "setup_not_complete"
  | "active_admin_exists"
  | "gateway_url_invalid"
  | "gateway_token_required"
  | "gateway_config_missing"
  | "gateway_pairing_required"
  | "gateway_auth_failed"
  | "gateway_device_token_expired"
  | "gateway_write_access_missing"
  | "gateway_unreachable"
  | "stream_failed"
  | "attachment_too_large"
  | "lazycat_invalid_selection"
  | "lazycat_empty_selection"
  | "lazycat_unavailable"
  | "lazycat_invalid_path"
  | "lazycat_file_required"
  | "lazycat_filename_missing"
  | "backup_invalid_import"
  | "backup_file_missing"
  | "share_password_required"
  | "copy_unavailable"
  | "copy_failed";

export type LocalizedErrorPayload = {
  error: string;
  errorCode: UserFacingErrorCode;
  errorDiagnostic?: string;
};

function messageForCode(messages: Dictionary, code: UserFacingErrorCode) {
  switch (code) {
    case "setup_not_complete":
      return messages.errors.setupNotComplete;
    case "active_admin_exists":
      return messages.errors.activeAdminExists;
    case "gateway_url_invalid":
      return messages.errors.gatewayUrlInvalid;
    case "gateway_token_required":
      return messages.errors.gatewayTokenRequired;
    case "gateway_config_missing":
      return messages.errors.gatewayConfigMissing;
    case "gateway_pairing_required":
      return messages.errors.gatewayPairingRequired;
    case "gateway_auth_failed":
      return messages.errors.gatewayAuthFailed;
    case "gateway_device_token_expired":
      return messages.errors.gatewayDeviceTokenExpired;
    case "gateway_write_access_missing":
      return messages.errors.gatewayWriteAccessMissing;
    case "gateway_unreachable":
      return messages.errors.gatewayUnreachable;
    case "stream_failed":
      return messages.errors.streamFailed;
    case "attachment_too_large":
      return messages.errors.attachmentTooLarge;
    case "lazycat_invalid_selection":
      return messages.errors.lazycatInvalidSelection;
    case "lazycat_empty_selection":
      return messages.errors.lazycatEmptySelection;
    case "lazycat_unavailable":
      return messages.errors.lazycatUnavailable;
    case "lazycat_invalid_path":
      return messages.errors.lazycatInvalidPath;
    case "lazycat_file_required":
      return messages.errors.lazycatFileRequired;
    case "lazycat_filename_missing":
      return messages.errors.lazycatFilenameMissing;
    case "backup_invalid_import":
      return messages.errors.backupInvalidImport;
    case "backup_file_missing":
      return messages.errors.backupFileMissing;
    case "share_password_required":
      return messages.errors.sharePasswordRequired;
    case "copy_unavailable":
      return messages.errors.copyUnavailable;
    case "copy_failed":
      return messages.errors.copyFailed;
    default:
      return messages.common.unknownError;
  }
}

function cleanDiagnostic(message: string) {
  return message
    .replace(/^\[openclaw\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function buildDiagnostic(error: unknown) {
  if (error instanceof OpenClawGatewayError) {
    return cleanDiagnostic(error.message);
  }

  if (error instanceof ZodError) {
    return cleanDiagnostic(error.issues[0]?.message ?? error.message);
  }

  if (error instanceof Error && error.message.trim()) {
    return cleanDiagnostic(error.message);
  }

  return undefined;
}

export function errorFromCode(
  messages: Dictionary,
  code: UserFacingErrorCode,
  options?: { diagnostic?: string | undefined; includeDiagnostic?: boolean },
): LocalizedErrorPayload {
  const diagnostic =
    options?.includeDiagnostic && options.diagnostic?.trim() ? options.diagnostic.trim() : undefined;

  return {
    error: messageForCode(messages, code),
    errorCode: code,
    ...(diagnostic ? { errorDiagnostic: diagnostic } : {}),
  };
}

export function inferErrorCode(error: unknown): UserFacingErrorCode {
  if (error instanceof OpenClawGatewayError) {
    if (error.detailCode === "PAIRING_REQUIRED") {
      return "gateway_pairing_required";
    }

    if (
      error.detailCode === "AUTH_TOKEN_MISMATCH" ||
      error.detailCode === "AUTH_PASSWORD_MISMATCH" ||
      error.detailCode === "AUTH_PASSWORD_NOT_CONFIGURED"
    ) {
      return "gateway_auth_failed";
    }

    if (error.detailCode === "AUTH_DEVICE_TOKEN_MISMATCH") {
      return "gateway_device_token_expired";
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (message === "Setup is not complete") {
    return "setup_not_complete";
  }

  if (message === "An active admin already exists") {
    return "active_admin_exists";
  }

  if (message === "PAIRING_REQUIRED" || lowerMessage.includes("device pairing required")) {
    return "gateway_pairing_required";
  }

  if (message.includes("Gateway URL must use ws:// or wss://")) {
    return "gateway_url_invalid";
  }

  if (message.includes("Gateway credential is required") || message.includes("Gateway token is required")) {
    return "gateway_token_required";
  }

  if (
    lowerMessage.includes("token mismatch") ||
    lowerMessage.includes("password mismatch") ||
    lowerMessage.includes("password is not configured on the gateway")
  ) {
    return "gateway_auth_failed";
  }

  if (lowerMessage.includes("stale or revoked")) {
    return "gateway_device_token_expired";
  }

  if (message.includes("Gateway runtime config is not initialized")) {
    return "gateway_config_missing";
  }

  if (lowerMessage.includes("missing scope: operator.write")) {
    return "gateway_write_access_missing";
  }

  if (
    message.includes("WebSocket not connected") ||
    message.includes("Gateway connection closed") ||
    lowerMessage.includes("connect rejected") ||
    lowerMessage.includes("connect failed") ||
    lowerMessage.includes("chat.send failed") ||
    lowerMessage.includes("devices.list failed")
  ) {
    return "gateway_unreachable";
  }

  if (message.includes("File exceeds MAX_UPLOAD_BYTES")) {
    return "attachment_too_large";
  }

  if (message.includes("must be an absolute path")) {
    return "lazycat_invalid_path";
  }

  if (message.includes("LAZYCAT_SOURCE_FILE_ACCESS_ROOT is not configured")) {
    return "lazycat_unavailable";
  }

  if (message.includes("non-file entry")) {
    return "lazycat_file_required";
  }

  if (message.includes("without filename")) {
    return "lazycat_filename_missing";
  }

  if (message.includes("payload is not a valid file list")) {
    return "lazycat_invalid_selection";
  }

  if (message.includes("did not include any files")) {
    return "lazycat_empty_selection";
  }

  if (message === "Password is required") {
    return "share_password_required";
  }

  if (
    message.includes("Invalid backup") ||
    message.includes("Duplicate ") ||
    message.includes("references missing") ||
    message.includes("Manifest shardCount") ||
    message.includes("Conversation package") ||
    message.includes("Legacy single-file conversation") ||
    message.includes("exactly one conversation manifest") ||
    message.includes("do not exactly match") ||
    message.includes("Missing shard file") ||
    message.includes("checksum mismatch") ||
    message.includes("not referenced by the manifest") ||
    message.includes("requires all shard files") ||
    message.includes("Import the manifest file") ||
    message.includes("single importable envelope")
  ) {
    return "backup_invalid_import";
  }

  if (message.includes("Backup file not found") || message.includes("Invalid backup file name")) {
    return "backup_file_missing";
  }

  if (message === "Clipboard is unavailable") {
    return "copy_unavailable";
  }

  if (message === "Copy command failed") {
    return "copy_failed";
  }

  if (message.includes("Failed to stream OpenClaw response")) {
    return "stream_failed";
  }

  return "unknown";
}

export function localizeError(
  messages: Dictionary,
  error: unknown,
  options?: {
    fallbackCode?: UserFacingErrorCode;
    includeDiagnostic?: boolean;
  },
): LocalizedErrorPayload {
  const inferredCode = inferErrorCode(error);
  const code = inferredCode === "unknown" ? (options?.fallbackCode ?? "unknown") : inferredCode;

  return errorFromCode(messages, code, {
    includeDiagnostic: options?.includeDiagnostic,
    diagnostic: buildDiagnostic(error),
  });
}

export function localizePersistedGatewayMessage(
  messages: Dictionary,
  status: "healthy" | "pairing_required" | "failed" | null | undefined,
  rawMessage: string | null | undefined,
) {
  if (status === "pairing_required") {
    return messageForCode(messages, inferErrorCode(new Error(rawMessage ?? "PAIRING_REQUIRED")));
  }

  if (status === "failed" && rawMessage) {
    return messageForCode(messages, inferErrorCode(new Error(rawMessage)));
  }

  return rawMessage ?? null;
}
