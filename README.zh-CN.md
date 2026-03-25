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
- 内置管理后台，可创建用户、禁用账号、重置密码并显示配对状态
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
5. 管理员可通过后台管理账号，并查看 pairing 相关状态。

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
- 在管理流程中显示 gateway pairing 状态

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
|-- .env.dev.example
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

## 环境变量

项目会在 `src/lib/env.ts` 中校验环境变量。

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | Prisma 使用的 PostgreSQL 连接串。 |
| `SESSION_SECRET` | 是 | Session 签名密钥，长度至少 32 个字符。 |
| `OPENCLAW_GATEWAY_URL` | 是 | OpenClaw gateway 的 WebSocket 地址。 |
| `OPENCLAW_GATEWAY_TOKEN` | 否 | 如果你的 OpenClaw 部署要求 token，可在这里配置。 |
| `OPENCLAW_UPLOAD_DIR_CONTAINER` | 否 | 本应用视角下的上传目录，默认 `/shared/uploads`。 |
| `OPENCLAW_UPLOAD_DIR_HOST` | 否 | OpenClaw 可读取的宿主机路径，默认 `/srv/miniteamclaw/uploads`。 |
| `MAX_UPLOAD_BYTES` | 否 | 单个附件大小上限，默认 `15728640`（15 MiB）。 |
| `OPENCLAW_VERBOSE_LEVEL` | 否 | Gateway 日志详细程度，可选值：`off`、`full`。 |
| `APP_URL` | 否 | 在需要绝对地址时使用的应用外部访问地址。 |
| `SEED_ADMIN_USERNAME` | 仅 seed 使用 | `npm run db:seed` 时初始管理员用户名。 |
| `SEED_ADMIN_PASSWORD` | 仅 seed 使用 | `npm run db:seed` 时初始管理员密码。 |
| `SEED_ADMIN_AGENT_ID` | 仅 seed 使用 | 初始管理员的 `openclawAgentId`，默认 `main`。 |

## 环境模板

可通过辅助脚本切换：

```bash
npm run env:dev
npm run env:docker
```

这两个命令会把以下模板之一复制为 `.env`：

- `.env.dev.example`
- `.env.docker.example`

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
- 上传目录在应用侧和 OpenClaw 侧的映射必须一致。
- 仓库内置的 `docker-compose.yml` 默认使用宿主机目录 `/home/openclaw/miniteamclaw/uploads`。
- Docker 模式下，`OPENCLAW_GATEWAY_URL` 通常会配置为 `ws://host.docker.internal:19001`。

## 当前定位

这个仓库的目标是一个务实、可自托管的小团队 UI，而不是替代 OpenClaw 本体。它主要负责账号管理、会话编排，以及一层适合浏览器使用的 gateway 前端。

## 贡献说明

欢迎提 Issue 和 Pull Request。如果你准备提交代码，建议注意下面这些约束：

- 项目基于 Next.js 16 App Router。
- Gateway 通信全部通过服务端中转。
- 涉及上传路径、会话持久化或 pairing 流程的改动需要特别谨慎，因为它们会跨越多个系统边界。

## 许可证

当前仓库还没有附带 `LICENSE` 文件。如果你准备公开发布或正式接收开源贡献，建议先补上明确的许可证。
