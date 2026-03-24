import type { Dictionary } from "@/lib/i18n/dictionary";
import { interpolate } from "@/lib/i18n/dictionary";

export function t(message: string, params?: Record<string, string | number>) {
  return params ? interpolate(message, params) : message;
}

export function getLifecycleTitle(messages: Dictionary, phase: "started" | "completed" | "failed" | "aborted" | "pairing_required") {
  switch (phase) {
    case "started":
      return messages.chat.lifecycleStarted;
    case "completed":
      return messages.chat.lifecycleCompleted;
    case "aborted":
      return messages.chat.lifecycleAborted;
    case "pairing_required":
      return messages.chat.lifecyclePairingRequired;
    default:
      return messages.chat.lifecycleFailed;
  }
}
