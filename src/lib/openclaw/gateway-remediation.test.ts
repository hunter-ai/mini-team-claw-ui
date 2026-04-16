import assert from "node:assert/strict";
import test from "node:test";
import { inferGatewayRemediation } from "@/lib/openclaw/gateway-remediation";

test("inferGatewayRemediation returns reset action for stale or revoked device tokens", () => {
  assert.deepEqual(
    inferGatewayRemediation("failed", "[openclaw] connect rejected: cached device token is stale or revoked."),
    {
      action: "reset_device_token",
      reason: "device_token_expired",
    },
  );
});

test("inferGatewayRemediation ignores unrelated gateway failures", () => {
  assert.equal(
    inferGatewayRemediation("failed", "[openclaw] connect rejected: gateway auth token mismatch."),
    null,
  );
  assert.equal(inferGatewayRemediation("healthy", "anything"), null);
});
