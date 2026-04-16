import { inferErrorCode } from "@/lib/user-facing-errors";

export type GatewayRemediation =
  | {
      action: "reset_device_token";
      reason: "device_token_expired";
    }
  | null;

export function inferGatewayRemediation(status: string | null | undefined, rawMessage: string | null | undefined): GatewayRemediation {
  if (status !== "failed" || !rawMessage) {
    return null;
  }

  const errorCode = inferErrorCode(new Error(rawMessage));
  if (errorCode === "gateway_device_token_expired") {
    return {
      action: "reset_device_token",
      reason: "device_token_expired",
    };
  }

  return null;
}
