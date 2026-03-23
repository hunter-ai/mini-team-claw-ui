# MiniTeamClawUI

 Mobile-first WebUI for sharing a single host OpenClaw gateway across a small team, with per-member login, per-member agent mapping, multi-session chat, and attachment prompts.

## Stack

- Next.js 16 App Router
- Prisma + PostgreSQL
- Cookie-based auth with argon2id password verification
- OpenClaw Gateway WebSocket bridge from the server
- Docker for the WebUI, host-native OpenClaw on the same machine

## Environment

Copy `.env.example` to `.env` and adjust:

- `OPENCLAW_GATEWAY_URL` should point from the container to the host gateway, typically `ws://host.docker.internal:19001`
- `OPENCLAW_UPLOAD_DIR_HOST` must be the host path that OpenClaw can read
- `OPENCLAW_UPLOAD_DIR_CONTAINER` must match the bind-mounted path inside the container
- `SESSION_SECRET` must be at least 32 characters

## First Run

```bash
npm install
npx prisma generate
npm run db:push
npm run db:seed
npm run dev
```

For Docker:

```bash
cp .env.example .env
mkdir -p /srv/miniteamclaw/uploads
docker compose up --build
```

## Notes

- The browser never connects to OpenClaw directly. The WebUI server handles Gateway auth and chat requests.
- Attachments are saved into the bind-mounted host directory and sent to OpenClaw as `MEDIA:<host-path>` lines.
- Message history is cached in the app database for the sessions created through this UI.
