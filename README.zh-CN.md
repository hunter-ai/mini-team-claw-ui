# MiniTeamClawUI

一个面向小团队的移动优先 Next.js Web UI，用来在多人之间共享同一个 OpenClaw gateway。

MiniTeamClawUI 在已有 OpenClaw 部署之上补充了账号体系、按用户映射 agent、会话持久化、附件处理和轻量级管理后台。浏览器不会直接连接 OpenClaw，所有 gateway 访问都由 Next.js 服务端代理并在本地保存应用状态。

[English README](./README.md)

## 项目亮点

- 基于 Cookie Session 的本地登录体系，密码使用 Argon2 哈希
- 按用户配置 `openclawAgentId`，把不同成员路由到不同 OpenClaw agent
- 支持多会话聊天，并持久化本地历史记录
- 服务端附件上传流程，可把文件映射为 OpenClaw 可读取的主机路径
- 支持从 gateway 拉取并选择技能
- 内置管理后台，可创建用户、禁用账号并重置密码
- 内建英文与简体中文双语路由
- 提供 Docker 部署路径，适合与宿主机上的 OpenClaw 一起运行

## 技术栈

- Next.js 16 App Router
- React 19
- TypeScript
- Prisma
- PostgreSQL
- OpenClaw Gateway WebSocket 桥接
- Tailwind CSS 4

## 工作方式

1. 用户先在本地应用数据库中完成认证。
2. Next.js 服务端负责建立和管理到 OpenClaw gateway 的连接。
3. 聊天会话、流式运行事件、消息缓存、附件和用户元数据都存储在本地 PostgreSQL 中。
4. 上传文件会保存到共享目录，再以宿主机可见路径形式传给 OpenClaw。
5. 管理员可通过后台管理账号。

这种设计把 gateway 凭证和 operator 能力留在服务端，避免暴露给浏览器。

## 功能说明

### 聊天

- 创建并恢复聊天会话
- 持久化通过本 UI 创建的会话历史
- 流式展示 assistant 回复和 run 活动
- 支持给 prompt 附加文件
- 支持 slash command 和 gateway skill 集成

### 管理后台

- 创建 `ADMIN` 和 `MEMBER` 用户
- 为每个用户分配 `openclawAgentId`
- 启用、禁用、删除用户
- 强制重置密码

### 国际化

- 默认英文路由组
- `/zh` 下的简体中文路由组

## 项目结构

```text
.
|-- src/app/                 # App Router 页面、布局与 API 路由
|-- src/components/          # 客户端与服务端 UI 组件
|-- src/lib/                 # 认证、会话、gateway 桥接、i18n、工具函数
|-- prisma/                  # Prisma schema 与 seed 脚本
|-- public/                  # 静态资源
|-- scripts/                 # 项目辅助脚本
|-- Dockerfile
|-- docker-compose.yml
|-- docker-compose.prod.yml
|-- .env.dev.example
|-- .env.prod.example
|-- .env.docker.example
|-- .env.example
```

## 运行要求

- Node.js 22 或更高版本
- npm 10 或更高版本
- PostgreSQL 16，或兼容的 PostgreSQL 实例
- 一个可访问的 OpenClaw gateway
- 一个同时能被本应用和 OpenClaw 看到的共享上传目录

## 快速开始

### 本地开发

首次使用需要在 OpenClaw 的环境下手动通过设备配对请求。

```bash
npm install
npm run env:dev
npm run prisma:generate
npm run db:push
npm run db:seed
npm run dev
```

启动后访问 `http://localhost:3000`。

### Docker Compose

```bash
npm run env:docker
mkdir -p /home/openclaw/miniteamclaw/uploads
docker compose up --build
```

容器启动时会自动执行：

- `npx prisma db push`
- `npm run db:seed`
- `npm run start`

本地开发建议保持 `ADMIN_BOOTSTRAP_MODE=seed`，这样 `npm run db:seed` 会根据 `SEED_ADMIN_*` 自动创建默认管理员。

### 生产镜像部署

仓库现在额外提供了面向生产部署的 [`docker-compose.prod.yml`](./docker-compose.prod.yml)，它会直接拉取预构建镜像 `ihunterdev/miniteamclawui:0.0.2`。

推荐的启动流程：

```bash
cp .env.prod.example .env.prod
mkdir -p /home/openclaw/miniteamclaw/uploads
docker compose -f docker-compose.prod.yml up -d
```

说明：

- 首次启动前请先修改 `.env.prod`，尤其是 `SESSION_SECRET`、`OPENCLAW_GATEWAY_URL`、`OPENCLAW_GATEWAY_AUTH_MODE`，以及对应的 gateway 凭证（`OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD`）。
- 生产模板默认使用 `ADMIN_BOOTSTRAP_MODE=ui`。完成 gateway 检查后，请在 setup 页面创建首个管理员。
- 该 compose 文件默认把应用绑定到 `127.0.0.1:3000`。
- PostgreSQL 数据会持久化到名为 `postgres_data` 的 Docker volume。
- 镜像配置了 `pull_policy: always`，启动时会检查是否有更新版本可拉取。

## 使用提示

### 兼容性说明

- 本项目从 OpenClaw `2026.3.13` 版本开始适配。
- 更早版本，以及之后更新的版本，都不保证能够完全兼容。
- 如果你使用的是不同版本的 OpenClaw，建议在正式部署前先核对 gateway 行为、会话生命周期行为以及配置字段名。

### 会话归档说明

- MiniTeamClawUI 会在最后一条消息后的 7 天自动归档会话。
- 你需要同时在 OpenClaw 里配置相同的 7 天自动归档规则，这样 UI 和 gateway 的会话生命周期才一致。
- 截止目前，OpenClaw 还不支持把会话长期保留。
- 因此，使用这个项目时需要默认接受一个前提：旧会话会进入归档状态，而不是被永久保留。

给你的龙虾使用的示例提示词：

```text
请帮我修改当前 OpenClaw 的配置，把聊天会话设置为在 7 天无活动后自动归档，具体设置为 `session.reset.mode = "idle"`，`idleMinutes = 10080`。先确认我当前 OpenClaw 实际使用的配置文件位置，再执行修改，最后把你改了什么明确告诉我。
```

## 环境变量

项目会在 `src/lib/env.ts` 中校验环境变量。

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Prisma 使用的 PostgreSQL 连接串。 |
| `SESSION_SECRET` | 是 | Session 签名密钥，长度至少 32 个字符。 |
| `ADMIN_BOOTSTRAP_MODE` | 否 | 管理员初始化模式。开发建议使用 `seed`，生产首次安装建议使用 `ui`。默认值：`seed`。 |
| `ENABLE_LAZYCAT_FILE_PICKER` | 否 | 设为 `true` 后，会在运行环境支持时于聊天页显示懒猫微服 NAS 文件选择入口。默认值：`false`。 |
| `ATTACHMENTS_FILE_ACCESS_ROOT` | 否 | UI 服务视角下的真实附件存储根目录。浏览器上传文件会写到这里，从懒猫复制出来的文件也会落到这里。默认值：`/shared/uploads`。 |
| `ATTACHMENTS_MESSAGE_PATH_ROOT` | 否 | 发送给 OpenClaw/龙虾时使用的附件路径根目录。默认值：`/srv/miniteamclaw/uploads`。 |
| `LAZYCAT_SOURCE_FILE_ACCESS_ROOT` | 否 | UI 服务在复制前实际读取懒猫原文件时使用的根目录。使用懒猫附件时必须配置。 |
| `OPENCLAW_GATEWAY_URL` | 是 | OpenClaw gateway 的 WebSocket 地址。 |
| `OPENCLAW_GATEWAY_AUTH_MODE` | 否 | Gateway 认证方式，可选值：`token`、`password`。默认 `token`。 |
| `OPENCLAW_GATEWAY_TOKEN` | 否 | 当 `OPENCLAW_GATEWAY_AUTH_MODE=token` 时使用的 Gateway Token。 |
| `OPENCLAW_GATEWAY_PASSWORD` | 否 | 当 `OPENCLAW_GATEWAY_AUTH_MODE=password` 时使用的 Gateway Password。 |
| `MAX_UPLOAD_BYTES` | 否 | 单个附件大小上限，默认 `1073741824`（1 GiB）。 |
| `OPENCLAW_VERBOSE_LEVEL` | 否 | Gateway 日志详细程度，可选值：`off`、`full`。 |
| `APP_URL` | 否 | 在需要绝对地址时使用的应用外部访问地址。 |
| `OIDC_ISSUER` | 否 | OIDC issuer 地址。需与 `OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`APP_URL` 一起配置后启用 SSO。 |
| `OIDC_CLIENT_ID` | 否 | SSO 登录使用的 OIDC client ID。 |
| `OIDC_CLIENT_SECRET` | 否 | SSO 登录使用的 OIDC client secret。 |
| `OIDC_SCOPES` | 否 | 以空格分隔的 OIDC scope。默认值：`openid profile`。 |
| `OIDC_BRAND_NAME` | 否 | OIDC 登录按钮展示的可选品牌名。例如配置为 `Authing` 后，按钮会显示为 `使用 Authing 登录`。 |
| `SEED_ADMIN_USERNAME` | 仅 seed 模式使用 | 当 `ADMIN_BOOTSTRAP_MODE=seed` 时，`npm run db:seed` 使用的初始管理员用户名。 |
| `SEED_ADMIN_PASSWORD` | 仅 seed 模式使用 | 当 `ADMIN_BOOTSTRAP_MODE=seed` 时，`npm run db:seed` 使用的初始管理员密码。 |
| `SEED_ADMIN_AGENT_ID` | 仅 seed 模式使用 | 当 `ADMIN_BOOTSTRAP_MODE=seed` 时，初始管理员的 `openclawAgentId`，默认 `main`。 |

## 环境模板

可通过辅助脚本切换：

```bash
npm run env:dev
npm run env:docker
```

这两个命令会把以下模板之一复制为 `.env`：

- `.env.dev.example`
- `.env.docker.example`

如果使用生产镜像部署，请以 `.env.prod.example` 为基础生成 `.env.prod`。

## 数据库

Prisma schema 目前包含以下核心实体：

- `User`
- `UserSession`
- `ChatSession`
- `ChatMessageCache`
- `Attachment`
- `ChatRun`
- `ChatRunEvent`
- `GatewayOperatorIdentity`

虽然模型执行由 OpenClaw 完成，但应用仍会在本地保存聊天与会话状态。

## 可用脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发服务器。 |
| `npm run build` | 构建生产版本。 |
| `npm run start` | 启动生产服务。 |
| `npm run lint` | 运行 ESLint。 |
| `npm run env:dev` | 将 `.env.dev.example` 复制为 `.env`。 |
| `npm run env:docker` | 将 `.env.docker.example` 复制为 `.env`。 |
| `npm run prisma:generate` | 生成 Prisma Client。 |
| `npm run db:push` | 将 Prisma schema 推送到数据库。 |
| `npm run db:seed` | 在 seed 环境变量存在时初始化管理员账号。 |

## 部署说明

- 浏览器不会直接连接 OpenClaw。
- Web 服务必须能够通过 WebSocket 访问 gateway。
- `ATTACHMENTS_FILE_ACCESS_ROOT` 和 `ATTACHMENTS_MESSAGE_PATH_ROOT` 是附件路径的新标准变量。所有附件都在这两个根目录下共享同一个相对路径。
- 浏览器直接上传的文件会写入 `ATTACHMENTS_FILE_ACCESS_ROOT`，发送给 OpenClaw/龙虾时则改写成 `ATTACHMENTS_MESSAGE_PATH_ROOT` 下的对应路径。
- 懒猫选择的文件会先从 `LAZYCAT_SOURCE_FILE_ACCESS_ROOT` 读取，再复制到 `ATTACHMENTS_FILE_ACCESS_ROOT`，最后按 `ATTACHMENTS_MESSAGE_PATH_ROOT` 下的对应路径发给 OpenClaw/龙虾。
- 一个典型的分离部署示例是：UI 把附件写到 `/shared/uploads/...`，而 OpenClaw/龙虾读取同一附件时使用 `/lzcapp/run/mnt/home/miniteamclawui/uploads/...`。
- 仓库内置的 `docker-compose.yml` 默认使用宿主机目录 `/home/openclaw/miniteamclaw/uploads`。
- 仓库内置的 `docker-compose.prod.yml` 默认拉取 `ihunterdev/miniteamclawui:0.0.2`，并优先读取 `.env.prod` 里的环境变量。
- Docker 模式下，`OPENCLAW_GATEWAY_URL` 通常会配置为 `ws://host.docker.internal:18789`。

## 当前定位

这个仓库的目标是一个务实、可自托管的小团队 UI，而不是替代 OpenClaw 本体。它主要负责账号管理、会话编排，以及一层适合浏览器使用的 gateway 前端。

## 贡献说明

欢迎提 Issue 和 Pull Request。如果你准备提交代码，建议注意下面这些约束：

- 项目基于 Next.js 16 App Router。
- Gateway 通信全部通过服务端中转。
- 涉及上传路径或会话持久化的改动需要特别谨慎，因为它们会跨越多个系统边界。

## 许可证

本项目采用 MIT License，详见 [`LICENSE`](./LICENSE)。
