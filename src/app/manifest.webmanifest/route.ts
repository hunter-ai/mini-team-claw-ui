import { NextResponse } from "next/server";

export function GET() {
  return new NextResponse(
    JSON.stringify({
    name: "MiniTeamClawUI",
    short_name: "MiniTeamClawUI",
    description: "Team-scoped mobile-first WebUI for OpenClaw.",
    start_url: "/chat",
    display: "standalone",
    background_color: "#120f0d",
    theme_color: "#fbbf24",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json",
      },
    },
  );
}
