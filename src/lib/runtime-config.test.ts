import assert from "node:assert/strict";
import test from "node:test";
import { inferGatewayAuthMode, validateRuntimeConfig } from "@/lib/runtime-config";

test("inferGatewayAuthMode honors explicit mode", () => {
  assert.equal(
    inferGatewayAuthMode({
      gatewayAuthMode: "password",
      gatewayToken: "token",
      gatewayPassword: "password",
    }),
    "password",
  );
});

test("inferGatewayAuthMode derives mode from a single configured secret", () => {
  assert.equal(inferGatewayAuthMode({ gatewayToken: "token" }), "token");
  assert.equal(inferGatewayAuthMode({ gatewayPassword: "password" }), "password");
  assert.equal(inferGatewayAuthMode({ gatewayToken: "token", gatewayPassword: "password" }), null);
});

test("validateRuntimeConfig requires the active credential", () => {
  assert.throws(
    () =>
      validateRuntimeConfig({
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayAuthMode: "password",
        gatewayPassword: "",
        gatewayToken: "token",
        appUrl: "",
      }),
    /Gateway credential is required/,
  );
});

test("validateRuntimeConfig accepts password mode with password", () => {
  const result = validateRuntimeConfig({
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayAuthMode: "password",
    gatewayPassword: "secret",
    gatewayToken: "",
    appUrl: "",
  });

  assert.equal(result.gatewayAuthMode, "password");
  assert.equal(result.gatewayPassword, "secret");
});
