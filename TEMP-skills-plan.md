# Skills List 方案暂存

## 目标

在聊天输入区“添加文件”按钮旁边增加一个“技能”按钮，点击后展示 OpenClaw 当前可识别的技能列表，方便用户选择技能并把技能意图带入当前会话。

第一版只做“技能发现 + 技能意图注入”，不做真正的技能执行编排。

## 已验证结论

- 当前环境下，Gateway 不支持 `skills.list`，调用会返回 `unknown method: skills.list`
- 当前环境下，Gateway 支持 `skills.status`
- `skills.status` 已经能返回完整技能清单，字段足够做 UI：
  - `name`
  - `description`
  - `source`
  - `bundled`
  - `filePath`
  - `baseDir`
  - `skillKey`
  - `eligible`
  - `disabled`
  - `blockedByAllowlist`
  - `missing`
  - `install`

结论：读取技能列表应走 `skills.status`，不要走 `skills.list`。

## 架构方案

### 1. 前端

在聊天输入区附件按钮旁新增“技能”按钮。

点击后打开一个技能面板，建议使用：

- 移动端：底部抽屉
- 桌面端：popover 或小型侧浮层

### 2. WebUI 服务端

新增只读接口：

- `GET /api/skills`

接口职责：

- 校验当前登录用户
- 服务端连接 OpenClaw Gateway
- 调用 `skills.status`
- 整理返回数据
- 返回前端可直接消费的技能列表

### 3. OpenClaw Gateway

统一作为技能清单数据源，调用方法：

- `skills.status`

## 为什么不用 CLI

虽然宿主机 `openclaw skills list --json` 可用，但不推荐作为主路径：

- 当前 WebUI 架构明确是浏览器不直连 OpenClaw，由服务端统一代理
- 容器内未安装 `openclaw` CLI，部署时不稳定
- Gateway 已经提供了可用的技能状态接口
- `skills.status` 更贴近当前 agent 工作区上下文

CLI 只适合作为后续兜底方案，不适合作为第一主路径。

## 推荐接口协议

### 路由

- `GET /api/skills`

### 建议响应结构

```ts
type SkillListItem = {
  key: string;
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  install: Array<{
    id: string;
    kind: string;
    label: string;
    bins: string[];
  }>;
};

type SkillsResponse = {
  workspaceDir: string | null;
  managedSkillsDir: string | null;
  skills: SkillListItem[];
  fetchedAt: string;
};
```

### 字段映射建议

- `key` 使用 `skillKey`
- `name` 直接透传
- `description` 直接透传
- `source` 直接透传
- `bundled` 直接透传
- `eligible` 直接透传
- `disabled` 直接透传
- `blockedByAllowlist` 直接透传
- `missing` 直接透传
- `install` 直接透传

不要把 `filePath`、`baseDir` 直接暴露给前端，除非你明确需要调试信息。

## 前端交互方案

### 按钮位置

放在聊天输入区底部操作行，与附件按钮同一排。

### 打开面板后默认行为

- 默认只展示 `eligible = true` 的技能
- 提供一个“显示全部”切换
- 支持按名称搜索

### 每个技能卡片展示

- 技能名
- 一句话描述
- 来源标签：`bundled` / `personal`
- 状态标签：
  - 可用
  - 缺依赖
  - 已禁用

### 排序规则

建议排序优先级：

1. `eligible = true`
2. `source = agents-skills-personal`
3. `bundled = true`
4. 名称字母序

## 第一版触发策略

第一版不要做“选中技能后立即调用某个单独接口执行技能”。

第一版建议只做“技能意图注入”：

- 用户点选一个技能
- 将技能信息插入当前输入框
- 或在输入框上方生成一个已选技能 badge

推荐注入形式：

```text
使用技能: pdf
需求:
```

或者：

```text
[@skill:pdf] 请帮我处理这个文件
```

这样优点是：

- 对现有消息发送流程改动最小
- 不需要重新定义复杂执行协议
- 仍然能让 agent 明确感知用户想用哪个技能

## 错误处理

`/api/skills` 建议只暴露有限错误分类：

- `技能列表暂时不可用`
- `无法连接 OpenClaw`
- `技能状态接口不可用`
- `技能数据格式异常`

前端不要直接显示底层 Gateway 原始报错给普通用户。

## 缓存建议

技能列表变化不频繁，建议：

- 服务端短缓存 15 到 60 秒
- 前端首次打开技能面板时请求
- 聊天页面加载时不强制预取

这样可以减轻 Gateway 压力。

## 权限建议

第一版建议：

- 登录用户都可读取技能列表
- 不做按用户裁剪

后续如果要做细粒度权限控制，再在 `/api/skills` 层按角色过滤返回项。

## 兜底策略

未来如果某些环境下 `skills.status` 不可用，可采用降级顺序：

1. 优先 Gateway `skills.status`
2. 失败时尝试宿主机 CLI `openclaw skills list --json`
3. 再失败则返回空列表并提示不可用

但当前环境下，第一条已经成立，足够作为主方案。

## 建议版本边界

第一版范围建议严格限定为：

- 增加“技能”按钮
- 接入 `/api/skills`
- 展示技能列表
- 支持搜索和“显示全部”
- 选中技能后将技能意图注入输入框

第一版不做：

- 真正的技能单独执行
- 技能安装
- 技能启停
- 技能权限管理
- 技能详情页
