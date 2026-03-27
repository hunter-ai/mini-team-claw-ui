export type LoginPrimaryAuthMethod = "oidc" | "password";

export function resolveLoginPrimaryAuthMethod(oidcEnabled: boolean): LoginPrimaryAuthMethod {
  return oidcEnabled ? "oidc" : "password";
}
