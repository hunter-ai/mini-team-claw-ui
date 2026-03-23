import type { NextConfig } from "next";

const allowedDevOrigins = (() => {
  const origins = new Set<string>(["localhost", "127.0.0.1"]);
  const appUrl = process.env.APP_URL;

  if (appUrl) {
    try {
      const { hostname } = new URL(appUrl);
      if (hostname) {
        origins.add(hostname);
      }
    } catch {
      // Ignore invalid APP_URL in local development.
    }
  }

  return [...origins];
})();

const nextConfig: NextConfig = {
  allowedDevOrigins,
  serverExternalPackages: ["ws"],
};

export default nextConfig;
