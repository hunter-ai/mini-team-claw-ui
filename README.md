# MiniTeamClawUI

Mobile-first Next.js web UI for sharing a single OpenClaw gateway across a small team.

MiniTeamClawUI adds account-based access, per-user agent mapping, session persistence, attachment handling, and a lightweight admin console on top of an existing OpenClaw deployment. The browser never talks to OpenClaw directly; the Next.js server brokers gateway access and stores local application state.

[中文说明](./README.zh-CN.md)

## Highlights

- Per-user login with cookie-based sessions, Argon2 password hashing, and optional OIDC SSO
- Per-member `openclawAgentId` mapping for routing users to different OpenClaw agents
- Multi-session chat UI with persisted local history
- Server-side attachment upload flow that maps files into OpenClaw-readable host paths
- Gateway-backed skill listing and selection
- Admin console for creating users, disabling accounts, and resetting passwords
- Built-in English and Simplified Chinese routes
- Docker deployment path for running the UI alongside a host OpenClaw gateway

## Tech Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Prisma
- PostgreSQL
- WebSocket bridge to OpenClaw Gateway
- Tailwind CSS 4

## How It Works

1. Users authenticate against the local app database or an external OIDC identity provider.
2. The Next.js server opens and manages the connection to the OpenClaw gateway.
3. Chat sessions, streamed run events, cached messages, attachments, and user metadata are stored locally in PostgreSQL.
4. Uploaded files are saved into a shared directory and sent to OpenClaw as host-visible file references.
5. Admins manage accounts from the built-in admin area.

This separation keeps gateway credentials and operator capabilities on the server side.

## Features

### Chat

- Create and resume chat sessions
- Persist message history for sessions created through this UI
- Stream assistant responses and run activity
- Attach files to prompts
- Use slash-command and gateway skill integrations

### Administration

- Create `ADMIN` and `MEMBER` users
- Assign each user an `openclawAgentId`
- Enable, disable, and delete users
- Force password resets
- View which local users have already linked an OIDC identity

### Localization

- Default English route group
- Simplified Chinese route group at `/zh`

## Project Structure

```text
.
|-- src/app/                 # App Router pages, layouts, and API routes
|-- src/components/          # Client and server UI components
|-- src/lib/                 # Auth, sessions, gateway bridge, i18n, utilities
|-- prisma/                  # Prisma schema and seed script
|-- public/                  # Static assets
|-- scripts/                 # Small project helper scripts
|-- Dockerfile
|-- docker-compose.yml
|-- docker-compose.prod.yml
|-- .env.dev.example
|-- .env.prod.example
|-- .env.docker.example
|-- .env.example
```

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL 16 or compatible PostgreSQL instance
- A reachable OpenClaw gateway
- A shared upload directory visible to both this app and OpenClaw

## Quick Start

### Local Development

Before first use, manually approve the device pairing request from within your OpenClaw environment.

```bash
npm install
npm run env:dev
npm run prisma:generate
npm run db:push
npm run db:seed
npm run dev
```

Open `http://localhost:3000` after the dev server starts.

### Docker Compose

```bash
npm run env:docker
mkdir -p /home/openclaw/miniteamclaw/uploads
docker compose up --build
```

The provided container startup command runs:

- `npx prisma db push`
- `npm run db:seed`
- `npm run start`

For local development, keep `ADMIN_BOOTSTRAP_MODE=seed` so `npm run db:seed` creates the default admin from `SEED_ADMIN_*`.

### Production Image

The repository now includes a production-oriented Docker Compose file at [`docker-compose.prod.yml`](./docker-compose.prod.yml) that pulls the prebuilt image `ihunterdev/miniteamclawui:0.0.2-oidc-no-email`.

Recommended setup flow:

```bash
cp .env.prod.example .env.prod
mkdir -p /home/openclaw/miniteamclaw/uploads
docker compose -f docker-compose.prod.yml up -d
```

Notes:

- Update `.env.prod` before first start, especially `SESSION_SECRET`, `OPENCLAW_GATEWAY_URL`, and `OPENCLAW_GATEWAY_TOKEN`.
- Production defaults to `ADMIN_BOOTSTRAP_MODE=ui`. After the gateway check passes, create the first admin from the setup page.
- The compose file binds the app to `127.0.0.1:3000` by default.
- PostgreSQL data is persisted in the named Docker volume `postgres_data`.
- The image uses `pull_policy: always`, so Docker will check for a newer image version when starting the stack.

## Usage Notes

### Compatibility Notice

- This project is adapted for the OpenClaw version line starting from 2026-03-13.
- Earlier versions, and future versions after that point, may not be perfectly compatible.
- If you are using a different OpenClaw version, verify gateway behavior, session lifecycle behavior, and configuration field names before deploying this UI in production.

### Session Archiving

- MiniTeamClawUI automatically archives sessions after 7 days since the last message.
- You should configure OpenClaw to use the same 7-day auto-archive rule, so the UI and gateway follow the same session lifecycle.
- As of now, OpenClaw does not support keeping sessions indefinitely for long-term retention.
- Because of that limitation, this project should be used with the expectation that old sessions will be archived rather than preserved forever.

Example prompt for your Lobster:

```text
Please update my OpenClaw configuration so chat sessions are automatically archived after 7 days of inactivity by setting `session.reset.mode = "idle"` and `idleMinutes = 10080`. First verify the exact config file path used by my current OpenClaw setup, then apply the change, and finally show me exactly what you changed.
```

## Environment Variables

The project validates environment variables in `src/lib/env.ts`.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string used by Prisma. |
| `SESSION_SECRET` | Yes | Session signing secret. Must be at least 32 characters. |
| `ADMIN_BOOTSTRAP_MODE` | No | Administrator bootstrap mode. Use `seed` for development and `ui` for production-style first-run setup. Default: `seed`. |
| `ENABLE_LAZYCAT_FILE_PICKER` | No | Set to `true` to expose the Lazycat NAS file picker entry in chat when the runtime supports it. Default: `false`. |
| `LAZYCAT_PICKER_PATH_PREFIX` | No | Absolute Lazycat path prefix stripped from picker results before host-path mapping. Default: `/`. |
| `OPENCLAW_GATEWAY_URL` | Yes | WebSocket URL for the OpenClaw gateway. |
| `OPENCLAW_GATEWAY_TOKEN` | No | Optional gateway token if your OpenClaw deployment requires it. |
| `OPENCLAW_UPLOAD_DIR_CONTAINER` | No | Upload directory as seen by this app. Default: `/shared/uploads`. |
| `OPENCLAW_UPLOAD_DIR_HOST` | No | Matching host path that OpenClaw can read. Default: `/srv/miniteamclaw/uploads`. |
| `OPENCLAW_LAZYCAT_HOST_ROOT` | No | Host root used to map Lazycat picker paths into OpenClaw-readable paths. Default: `/`. |
| `MAX_UPLOAD_BYTES` | No | Maximum attachment size in bytes. Default: `1073741824` (1 GiB). |
| `OPENCLAW_VERBOSE_LEVEL` | No | Debug verbosity for gateway logging. Allowed values: `off`, `full`. |
| `APP_URL` | No | Public app URL used where absolute URLs are needed. |
| `OIDC_ISSUER` | No | OIDC issuer URL. Enable together with `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `APP_URL`. |
| `OIDC_CLIENT_ID` | No | OIDC client ID for SSO login. |
| `OIDC_CLIENT_SECRET` | No | OIDC client secret for SSO login. |
| `OIDC_SCOPES` | No | Space-delimited OIDC scopes. Default: `openid profile`. |
| `OIDC_BRAND_NAME` | No | Optional brand name shown on the OIDC sign-in button. Example: `Authing` renders `Sign in with Authing`. |
| `SEED_ADMIN_USERNAME` | Seed mode only | Initial admin username used by `npm run db:seed` when `ADMIN_BOOTSTRAP_MODE=seed`. |
| `SEED_ADMIN_PASSWORD` | Seed mode only | Initial admin password used by `npm run db:seed` when `ADMIN_BOOTSTRAP_MODE=seed`. |
| `SEED_ADMIN_AGENT_ID` | Seed mode only | Initial admin `openclawAgentId` used by `npm run db:seed`. Defaults to `main`. |

## Environment Presets

Helper script:

```bash
npm run env:dev
npm run env:docker
```

These commands copy one of the bundled templates to `.env`:

- `.env.dev.example`
- `.env.docker.example`

For the production image flow, use `.env.prod.example` as the starting point for `.env.prod`.

## Database

The Prisma schema defines the following main entities:

- `User`
- `UserSession`
- `UserIdentity`
- `ChatSession`
- `ChatMessageCache`
- `Attachment`
- `ChatRun`
- `ChatRunEvent`
- `GatewayOperatorIdentity`

The app stores local chat/session state even though model execution happens through OpenClaw.

## Available Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the Next.js development server. |
| `npm run build` | Build the production app. |
| `npm run start` | Start the production server. |
| `npm run lint` | Run ESLint. |
| `npm run env:dev` | Copy `.env.dev.example` to `.env`. |
| `npm run env:docker` | Copy `.env.docker.example` to `.env`. |
| `npm run prisma:generate` | Generate the Prisma client. |
| `npm run db:push` | Push the Prisma schema to the database. |
| `npm run db:seed` | Seed the initial admin user if seed env vars are set. |

## Deployment Notes

- The browser does not connect to OpenClaw directly.
- The web server must be able to reach the gateway over WebSocket.
- The upload directory mapping must be correct on both the app side and the OpenClaw side.
- Lazycat direct attachments map picker `filename` values into `OPENCLAW_LAZYCAT_HOST_ROOT` instead of copying files into the upload directory.
- The bundled `docker-compose.yml` assumes the host upload path `/home/openclaw/miniteamclaw/uploads`.
- The bundled `docker-compose.prod.yml` pulls `ihunterdev/miniteamclawui:0.0.1` and reads environment values from `.env.prod` by default.
- In Docker mode, `OPENCLAW_GATEWAY_URL` commonly points to `ws://host.docker.internal:19001`.

## Current Scope

This repository is focused on a practical self-hosted team UI. It is not trying to replace OpenClaw itself. The core responsibility is account management, session orchestration, and a browser-friendly frontend around the gateway.

## Contributing

Issues and pull requests are welcome. If you plan to contribute code, keep these constraints in mind:

- This project uses the App Router in Next.js 16.
- Gateway communication is server-mediated.
- Changes that affect upload paths or session persistence should be tested carefully because they cross application boundaries.

## License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE).
