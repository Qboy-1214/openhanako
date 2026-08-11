# HanaAgent Web 多用户改造方案（REARCHITECTURE）

> 版本：v0.1（拷问收敛稿）｜日期：2026-08-05
> 配套术语表：`docs/CONTEXT.md`
> 现状基线：HanaAgent v0.442.0，Electron 42 + React 19 桌面应用 + 单实例 Node server。

## 0. 摘要（TL;DR）

砍掉 Electron 桌面版，把前端改为**一套响应式 React + PWA**（同时服务桌面/移动端浏览器）；
把后端 server 改造为**多用户、每用户独立 Engine 实例**的常驻服务，部署在 Linux/Docker；
每用户拥有独立数据子目录 + 独立数据库，自带 LLM Key+BaseURL，系统提供便宜兜底模型；
用户可创建脚本型工具（JS/TS/Python/Shell）与无代码工作流，二者均在 OS 级沙箱中执行；
内置工具/技能/Agent 全局只读共享，支持 fork 为私有与用户间分享；Bridge 保留并绑定到用户。

## 1. 背景与动机

当前形态是"单机单用户桌面应用"：全局单 `HanaEngine` + 单 `Hub`，数据全在 `~/.hanako`，
靠 `server-info.json` + SERVER_TOKEN 做本地进程握手，无账号体系、无网络暴露、无移动端。

用户目标：
1. 去桌面版 → 统一 Web（PC + 移动端浏览器 + PWA）。
2. 部署到 Linux/Docker，内置/创造/应用工具与脚本并返回输出物。
3. 多用户：每人登录后设自己的 LLM 供应商+模型，拥有自己的 session 列表与记录，PC/移动同步。
4. 系统内置工具/技能 + 每用户自建工具/技能/Agent。

## 2. 决策总表（ADR Index）

| ADR | 主题 | 决策 |
|---|---|---|
| ADR-1 | 前端形态 | 去 Electron，统一响应式 React 19 + PWA（manifest+SW） |
| ADR-2 | 部署暴露 | 双模态：公网 HTTPS 反代 / 内网隧道，环境变量 `connectionKind` 切换 |
| ADR-3 | 账号体系 | 自建密码账号为主 + 预留 OIDC 可插拔 |
| ADR-4 | 数据隔离 | 每用户独立子目录 + 独立 SQLite 库（SystemDB 与 UserDB 分离） |
| ADR-5 | Engine 映射 | **每用户独立 Engine 实例**（懒加载 + 空闲休眠，默认 30min） |
| ADR-6 | LLM 密钥 | 用户自带 Key+BaseURL；系统设便宜兜底模型（用户可选） |
| ADR-7 | 用户工具形态 | 脚本型（JS/TS/Python/Shell）+ 无代码工作流，两者都要 |
| ADR-8 | 内置/自建关系 | 全局只读共享 + 可 fork 私有 + 可用户间分享（三级） |
| ADR-9 | Bridge | 保留并绑定到用户（每用户配自己的 bot token） |
| ADR-10 | 执行沙箱 | 用户自建脚本统一 Docker/Seccomp 沙箱（FS/Net/资源限额） |
| ADR-11 | 规模/计费 | 小（<50 人）；不计费，仅用量统计支撑限流 |
| ADR-12 | 开放问题决议 | 兜底=用户自填 OpenAI 兼容 provider+key+model；分享=同实例全员免审核；推送=首版不做留接口；OIDC=仅留接口只做密码；注销=软删30天+硬删+分享转系统 |
| ADR-13 | 数据表设计 | SystemDB(账号/分享索引/全局配置) + UserDB(凭证加密/用量/私有资产/设置)；HANA_HOME/system 与 users/<userId> 两级布局，沿用 better-sqlite3 |
| ADR-14 | EngineLifecycle API | `use(userId)`/`keepAlive`/`release`/`drainAll`；懒加载+空闲休眠(复用 engine.dispose)；per-user 构造锁；替代启动期全局单例 |
| ADR-15 | Sandbox 协议 | `SandboxJob`/`SandboxResult` + `SandboxOrchestrator.execute`；容器(node/python/bash) + bwrap 二级隔离；密钥 tmpfs 注入；默认禁网；复用 lib/sandbox |
| ADR-16 | 分享市场 API | 复用现有 `PluginMarketplace`+`installPluginFromPath`；新增本地分享源 + `shared_assets` 索引；publish/discover/install/delete 端点；安装即 fork、强沙箱兜底 |
| ADR-17 | 路由层 userId 注入 | `open-root.ts` 全局 engine→注入 `engineLifecycle`；中间件按 principal.userId 取 Engine；WS 经 ticket userId；LOCAL_ONLY 改 SYSTEM_ADMIN/用户私有 |
| M0 | 去桌面骨架 | 首个可跑原型：弃 Electron 专有构建，server+Web 直连，多用户 EngineLifecycle+账号注册+userId 路由贯通；复用现有 dev-web/standalone |

## 3. 目标架构总览

```
                        ┌─────────────────────────────────────┐
   桌面/移动浏览器  ───▶│  Nginx/Caddy (HTTPS/反代/TLS)        │
   或 PWA            ───▶│  或 frp/cloudflared 隧道             │
                        └───────────────┬─────────────────────┘
                                        │ HTTP / WebSocket
                        ┌───────────────▼─────────────────────┐
                        │  HanaAgent Server (Node.js)          │
                        │  ├─ Auth (Account/OIDC) ── SystemDB  │
                        │  ├─ EngineLifecycle Manager          │
                        │  │    ├─ User A Engine (常驻/休眠)    │
                        │  │    ├─ User B Engine               │
                        │  │    └─ ... (<50)                    │
                        │  ├─ Sandbox Orchestrator (Docker)     │
                        │  ├─ Bridge Router (按 userId 分发)     │
                        │  └─ Sharing Market (用户间分享)        │
                        └───────────────┬─────────────────────┘
                                        │ FS
                        ┌───────────────▼─────────────────────┐
                        │  HANA_HOME/                          │
                        │   ├─ system/ (SystemDB, 兜底模型配置) │
                        │   └─ users/<userId>/                 │
                        │        ├─ memory/  sessions/          │
                        │        ├─ tools/   plugins/          │
                        │        └─ user.sqlite                │
                        └─────────────────────────────────────┘
```

要点：
- **Server 成为唯一进程边界**，不再有 Electron main/preload 分层。
- 前端通过 HTTP REST + WebSocket 直连 Server（沿用现有 `server/` 路由与 `ws-protocol`）。
- `EngineLifecycle` 是新增中枢：按 `userId` 管理 Engine 实例的存活。

## 3.5 现状契合度（代码审计结论）

改造前已读真实代码（`core/local-user-account.ts`、`server/routes/web-auth.ts`、
`shared/persistence/store-registry.ts`），确认项目**已具备多用户雏形**，本方案是**增量改造**而非从零：

| 已现成能力 | 代码位置 | 改造动作 |
|---|---|---|
| `userId` 密码账号（scrypt-sha256） | `core/local-user-account.ts` | 扩展为注册/注销/软删；当前仅 `defaultUserId` 单账号 → 支持多账号 |
| cookie 登录 + `principal.userId` | `server/routes/web-auth.ts` | 路由层已带 userId，复用 |
| 账号/工作室注册表（users.json） | `store-registry.ts user-studio-registries` | 从 `hanakoHome` 根迁到 `HANA_HOME/system/` |
| 按 agentId 分库 SQLite（facts/session/manifest） | `store-registry.ts *-sqlite` | 迁移到 `HANA_HOME/users/<userId>/` 下 |
| 用量账本 | `lib/llm/usage-ledger.ts` | 按 userId 分账（ADR-11 基础已存在） |
| WebSocket 换票 | `server/routes/ws-auth.ts` | 复用，叠加 userId 维度 |

**修正 ADR-4 一处假设**：原写"每用户独立子目录"——现明确：系统级共享数据
（账号表、分享索引、兜底配置、server 身份）保留在 `HANA_HOME/system/`，
用户私有数据迁到 `HANA_HOME/users/<userId>/`，path-guard 根切到后者。

## 4. ADR 详述

### ADR-1 前端形态：响应式 + PWA
- 移除 `desktop/main.cjs`、`preload.cjs`、窗口/对话框 IPC 层。
- `desktop/src`（React 19）改造为**纯 Web 应用**：以 `window.hana` contextBridge 调用的能力，
  改为走 HTTP/WS（文件选择、对话框等浏览器原生能力或新 REST 端点替代）。
- 同一套组件响应式适配移动端（CSS Modules + 断点）；新增 `manifest.webmanifest` 与
  Service Worker（离线缓存静态资源、加到主屏、Web Push 接收）。
- 多级窗口（onboarding/quick-chat/settings）改为 SPA 路由（或沿用 Zustand `currentTab`）。

### ADR-2 部署暴露：双模态
- 新增 `connectionKind` 环境变量：`public`（公网域名，信任 `x-forwarded-*` 与 `host` 头）
  或 `tunnel`（内网隧道，沿用现有 tunnel 信任态概念）。
- WebSocket 升级路径、cookie `SameSite`/`Secure` 随 `connectionKind` 调整。
- 提供 Dockerfile + compose（server + 可选 bridge worker），数据卷挂 `HANA_HOME`。

### ADR-3 账号体系：自建 + OIDC 可插拔
- 基于现有 `core/local-user-account.ts`（**scrypt-sha256 已现成**）+ `server/routes/web-auth.ts` 扩展：
  注册、登录、登出、改密、注销（软删30天）。密码哈希沿用 scrypt（无需换 argon2）。
- `principal` 已含 `userId`；`scopes` 沿用。预留 `oidc/` 路由与 `AuthProvider` 接口，
  首版只实现 `local`，OIDC 留接口与配置位（见 ADR-12.4）。

### ADR-4 数据隔离：每用户子目录 + 独立库
- `resolveHanakoHome` 改为 `resolveUserHome(userId)`，path-guard 根切到 `users/<userId>`。
- SystemDB（账号、兜底配置、分享索引）全局；UserDB 每用户一个（或统一库 `user_id` 分区）。
- 备份/迁移单位 = 单用户目录，运维友好。

### ADR-5 Engine 映射：每用户独立实例（懒加载 + 空闲休眠）
- 新增 `EngineLifecycle`：
  - `acquire(userId)`：缓存命中返回；未命中则读该 UserHome 构造 `HanaEngine` + `Hub` 并启动。
  - 空闲计时器：默认 30min 无活动 → 序列化/释放 Engine（保留 UserHome 数据）。
  - `release(userId)`：用户注销或删除 → 销毁实例、清内存。
- 契合"小 <50 人"：全在线也仅 ≤50 个常驻大对象，内存可接受；隔离在实例边界天然成立，
  **无需改造 Engine 内部状态机去切 userId**（这是选"独立实例"而非"共享路由"的最大收益）。
- 冷启动延迟由懒加载引入，靠空闲休眠阈值权衡（首条消息可能慢 1–2s）。

### ADR-6 LLM 密钥：用户自带 + 系统兜底
- 用户凭证（Key、BaseURL、模型列表）加密存 UserDB 或秘密库；调用时按 `userId` 路由 `provider-compat/*`。
- 系统后台配置一个便宜兜底模型（如轻量开源/低价 API），用户设置里可"启用兜底"开关；
  用户 Key 缺失或超限时回退兜底（若启用）。
- 密钥加解密用系统级 KMS/环境变量主密钥，不在前端明文出现。

### ADR-7 用户工具形态：脚本 + 无代码工作流
- **脚本型工具**：用户在 UI 定义（名称、参数 schema、运行时 JS/TS/Python/Shell + 源码），
  存为 plugin 式贡献（复用 `plugin-runtime` 的 tool 注册机制）。执行走 ADR-10 沙箱。
- **无代码工作流**：用户拼装内置工具 + 提示词成"工作流/子 Agent"（复用现有 workflow/子代理）。
  不写代码、更安全，存 UserDB。
- 两者在 ToolCatalog 中统一暴露给该用户 Engine。

### ADR-8 内置/自建关系：三级
- **A 全局只读共享**：系统内置工具/技能/Agent 全实例共享，用户不可改 origin。
- **B 可 fork 私有**：用户"复制为我的副本"后改，系统保留 origin；副本存 UserHome。
- **C 可用户间分享**：用户私有工具/Agent 可"发布"到 Sharing Market（系统级索引），
  其他用户可发现/安装（可选 fork）。需分享权限模型（发布者、可见范围）。

### ADR-9 Bridge：保留并绑定用户
- 现有 bridge 适配器（Telegram/飞书/QQ/微信）保留；每个用户在自己设置里填 bot token，
  绑定到自己的 UserHome/Engine。Bridge Router 按入站消息的 token 反查 `userId` 并投递。
- 多用户下 bot 冲突由"每用户独立 token"自然化解。

### ADR-10 执行沙箱：Docker/Seccomp 统一沙箱
- 新增 `Sandbox Orchestrator`：用户自建脚本工具执行时，起一个受限容器/Seccomp 进程：
  - FS：仅挂载该用户 UserHome 的工具/工作区子集（只读系统 + 可写用户区）。
  - Network：默认禁；工具声明需联网则显式放行（白名单域名）。
  - 资源：CPU/内存上限 + 超时（防跑爆服务器）。
- 内置/审核过工具走宽松策略（或同沙箱但信任级更高）。
- 沙箱运行时预装 Node + Python + Bash。

### ADR-11 规模/计费
- 目标 <50 同时在线：单节点、单 Server 进程、Engine 实例 ≤50。
- 不计费；用量统计（token、工具调用次数、沙箱执行次数）入 UserDB，用于限流与配额强制。

## 5. 改造清单（按模块）

### 5.1 删除 / 弃用
- `desktop/main.cjs`、`preload.cjs`、`preload.bundle.cjs`、窗口管理、自动更新、本地 IPC。
- `server-info.json` + SERVER_TOKEN 本地握手逻辑（被账号 cookie 替代）。
- `Guest` 路径、未登录留言。
- Electron 专属 vite 配置（`vite.config.main.js` / `preload` / `splash` / `theme` 中桌面专有部分）。

### 5.2 新增
- `server/engine-lifecycle.ts`：Engine 实例池 + 空闲休眠。
- `server/auth/` 扩展：注册、OIDC 接口位、SystemDB 账号表。
- `server/sandbox/`：Docker/Seccomp 编排器 + 运行时镜像构建。
- `server/sharing/`：用户间分享市场（索引 + 权限）。
- `desktop/src` → Web：PWA（manifest + SW）、响应式布局、去掉 `window.hana` 依赖改用 HTTP/WS。
- `deploy/`：Dockerfile、compose、Nginx/Caddy 示例、env 模板。

### 5.3 改造
- `lib/sandbox/path-guard.ts`：`hanakoHome`→`userHome(userId)` 参数化。
- `core` 启动：从"全局单例"改为"由 Lifecycle 按 userId 构造"。
- `server/routes/*`：所有路由增加 `userId` 上下文（从 session cookie/WS ticket 提取），
  路由到对应用户 Engine；`ws-scope` 权限模型叠加 `userId` 维度。
- `bridge/*`：token→userId 反查与按用户投递。
- `providers/*`：按 userId 取凭证 + 兜底模型回退逻辑。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 每用户 Engine 内存膨胀 | 懒加载 + 空闲休眠（ADR-5）；规模锁定 <50 |
| 用户脚本跑爆服务器 | OS 级沙箱 + 资源限额 + 超时 + 限流（ADR-10/11） |
| 密钥泄露 | 加密存储、不落前端、主密钥环境变量管理（ADR-6） |
| 串号/数据越权 | 每用户独立实例 + 独立子目录 + 路由强制 userId（ADR-4/5） |
| 冷启动延迟 | 空闲阈值调优；活跃会话保活（ADR-5） |
| PWA 离线一致性 | SW 仅缓存静态资源，数据走网络；冲突以服务端为准 |

## 7. 里程碑建议

1. **M0 去桌面骨架**：server 直连浏览器、基础账号登录、单用户 Web 跑通（验证去 Electron）。
2. **M1 多用户隔离**：EngineLifecycle + 每用户子目录/库 + userId 路由贯通。
3. **M2 工具与沙箱**：用户脚本工具 + 无代码工作流 + Docker 沙箱。
4. **M3 内置/分享三级**：fork 私有 + Sharing Market。
5. **M4 移动/PWA**：响应式完善 + PWA + Web Push；Bridge 绑定用户。
6. **M5 部署**：Docker 化 + 反代/隧道 + 兜底模型 + 限流。

## 8. ADR-12 开放问题决议（已拍板）

基于第 7 节遗留的 5 个开放问题，用户逐项确认如下：

### 8.1 兜底模型（ADR-6 落地）
- **用户自行填写 OpenAI 兼容的 provider + key + model** 作为兜底，而非平台预设某家。
- 即：系统在用户设置里提供"兜底模型"配置项，用户填入任意 OpenAI 兼容端点
  （baseURL + key + modelName）。缺失/超时/额度耗尽时回退到该配置。
- 平台**不预置、不承担**任何兜底成本；SystemDB 仅存该用户填的兜底配置（加密）。
- 推论：原方案中"系统后台设便宜兜底模型"改为**用户级自填兜底**，更贴合"用户主权"定位。

### 8.2 分享可见范围（ADR-8C 落地）
- **同实例全员，免审核**。所有注册用户可在 Sharing Market 发现/安装他人发布的工具/Agent。
- 安全不靠审核，靠 ADR-10 沙箱：任何安装进来的用户工具一律进强沙箱执行。
- Sharing Market = SystemDB 索引表（发布者 userId、资源类型、fork 来源、引用计数）；
  安装 = 在用户 UserHome 建指向 origin 的 fork 副本。

### 8.3 后台推送（PWA 边界）
- **首版不做 Web Push**；仅做应用内通知（网页打开时弹）+ 可选前端轮询角标。
- Service Worker / manifest 预留 VAPID 占位与 `push` 事件接口，未来可接 FCM/Mozilla 网关。
- 后端暂不实现 push 订阅端点与用户订阅表。

### 8.4 OIDC（ADR-3 边界）
- **首版仅留接口，只做自建密码**。定义 `AuthProvider` 抽象 + env 配置位，
  不接任何具体厂商（GitHub/Google/微信均不实现）。
- `principal` 已含 `userId`/`scopes`，未来 OIDC 只是新增一个 `AuthProvider` 实现映射第三方 claim。

### 8.5 账号注销数据销毁（ADR-4 合规边界）
- **硬删 + 软删缓冲（默认 30 天可恢复）+ 分享资源转系统所有**：
  - 用户注销 → 账号行标记 `status=deleted`、`deletedAt=now()`，进入 30 天软删窗口。
  - 窗口内用户再次登录 → 取消删除（恢复）。
  - 超时 → 定时任务物理删除 UserHome 目录 + UserDB 数据 + 释放 Engine 实例。
  - 该用户发布的共享工具/Agent → 删除时转为"系统内置"（剥离作者归属，保留功能），
    避免连累已安装的其他用户。
- UserDB 账号表加 `status` / `deletedAt` 字段；`EngineLifecycle.release` 在硬删时触发清理。

---

## 8.6 ADR-13 数据表与目录布局设计

本 ADR 将 ADR-4（隔离）与 ADR-12（兜底/分享/注销）落为具体 schema。
存储引擎沿用现有 `better-sqlite3`（`store-registry.ts` 已封装）。

### 8.6.1 文件系统布局（HANA_HOME）

```
HANA_HOME/
├─ system/                         # 系统级共享（SystemDB 所在）
│  ├─ system.sqlite                # 账号表、分享索引、server 身份
│  ├─ users.json                   # 账号索引（userId ↔ 目录映射，轻量）
│  └─ fallback/                    # (可选) 平台级兜底密钥，本方案不用
└─ users/<userId>/                 # 用户私有根（path-guard 根）
   ├─ user.sqlite                  # 用量账本、私有工具/技能/Agent 定义、设置
   ├─ memory/                      # 记忆（按天滚动，现有 memory/ 结构）
   ├─ sessions/                    # 会话 MD 流（现有 channels/ 结构）
   ├─ tools/                       # 用户自建脚本工具源码
   ├─ workflows/                   # 无代码工作流定义
   ├─ plugins/                     # 用户私有插件
   ├─ agent-facts.sqlite           # 现有 agent-facts-sqlite（迁此）
   ├─ session-manifest.sqlite      # 现有 session-manifest-sqlite（迁此）
   └─ studio-registry.json         # 现有 user-studio-registries（迁此）
```

> 迁移：现有 `hanakoHome` 根下的 `users/`、`agent-facts-sqlite` 等整体下沉到
> `HANA_HOME/users/<userId>/`；`users.json`、server 身份上移到 `HANA_HOME/system/`。

### 8.6.2 SystemDB（system/system.sqlite）

```sql
-- 账号表（ADR-3/12.5）
CREATE TABLE accounts (
  user_id       TEXT PRIMARY KEY,        -- 稳定 UUID
  handle        TEXT UNIQUE NOT NULL,    -- 登录名/邮箱
  pass_hash     TEXT NOT NULL,           -- scrypt-sha256（沿用 local-user-account）
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active|deleted
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,                 -- 软删时间戳（ADR-12.5）
  last_login_at INTEGER
);

-- 分享市场索引（ADR-8C/12.2）：同实例全员可见
CREATE TABLE shared_assets (
  asset_id    TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,             -- 原作者 userId
  kind        TEXT NOT NULL,             -- tool|skill|agent|workflow
  name        TEXT NOT NULL,
  origin_ref  TEXT,                      -- fork 来源 asset_id（若有）
  visibility  TEXT NOT NULL DEFAULT 'instance', -- instance（本方案仅此值）
  install_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  system_owned INTEGER NOT NULL DEFAULT 0  -- 作者注销后转 1（ADR-12.5）
);

-- server 身份 / 全局配置（含 connectionKind、兜底配置位）
CREATE TABLE system_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

### 8.6.3 UserDB（users/<userId>/user.sqlite）

```sql
-- 用户 LLM 供应商凭证（ADR-6/12.1）：自带 Key+BaseURL，加密存储
CREATE TABLE provider_creds (
  cred_id    TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,    -- openai-compatible / anthropic / deepseek ...
  base_url   TEXT,             -- 用户自填 endpoint
  api_key_enc TEXT NOT NULL,   -- 加密后的 key（主密钥来自 env，不在库明文）
  models     TEXT,             -- JSON 数组：用户可见模型列表
  is_fallback INTEGER NOT NULL DEFAULT 0,  -- 1=兜底（ADR-12.1）
  created_at INTEGER NOT NULL
);

-- 用量账本（ADR-11，沿用 usage-ledger 结构，按 userId 分库天然隔离）
CREATE TABLE usage_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  model       TEXT,
  kind        TEXT,            -- chat|tool|sandbox
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_ms     INTEGER,
  at          INTEGER NOT NULL
);

-- 私有工具/技能/Agent 定义（ADR-7/8B）
CREATE TABLE user_assets (
  asset_id    TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,   -- tool|skill|agent|workflow
  name        TEXT NOT NULL,
  def_json    TEXT NOT NULL,   -- 参数 schema / 脚本源码 / 工作流节点
  forked_from TEXT,            -- 若由内置或他人资产 fork（ADR-8B/8C）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 用户设置（含兜底启用开关、推送订阅占位 ADR-12.3）
CREATE TABLE user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

### 8.6.4 加密约定（ADR-6/12.1）
- `provider_creds.api_key_enc`：用 env 主密钥（如 `HANA_MASTER_KEY`）做 AES-256-GCM 加密，
  明文不落库、不落前端。解密仅在发起 LLM 调用时于 Server 进程内存中完成。
- 主密钥管理：Docker secret / env 注入，禁止提交进仓库。

### 8.6.5 与现有代码映射
- `accounts` ← 扩展 `local-user-account.ts`（加 register/delete/soft-delete）。
- `shared_assets` ← 新增 `server/sharing/`。
- `provider_creds` ← 新增，替代现有"单 home 全局凭证"。
- `usage_ledger` ← 复用 `lib/llm/usage-ledger.ts`，改为按 UserDB 落库。
- `user_assets` ← 新增，驱动 ADR-7 工具创建 UI 与 Engine 加载。

## 8.7 ADR-14 EngineLifecycle API 设计（ADR-5 落地）

本 ADR 将"每用户独立 Engine 实例 + 懒加载 + 空闲休眠"落为接口契约。
基于代码审计：当前 `server/index.ts` 在启动期一次性 `new HanaEngine({hanakoHome})`
+ `new Hub({engine})` 构造全局单例；`HanaEngine` 已有 `dispose()`（卸载 plugin、关 mcp、
关 session、关 store）。改造即把"单例构造"改为"按 userId 池化构造"。

### 8.7.1 位置与职责
- 新增 `server/engine-lifecycle.ts`，由 server 启动期建立**唯一** `EngineLifecycle` 实例。
- 它是路由层 / WS 层获取 Engine 的**唯一入口**，所有 handler 不再持有全局 engine。
- 依赖：SystemDB（`accounts` 校验存在性/状态）、UserHome 路径解析、Hub 构造依赖
  （EventBus/Scheduler/Bridge 等）、`HanaEngine` + `Hub` 构造器。

### 8.7.2 核心接口（TypeScript 签名）

```ts
// server/engine-lifecycle.ts
export interface UserEngineHandle {
  userId: string;
  engine: HanaEngine;     // 已 init 完成
  hub: Hub;
  acquiredAt: number;
  lastUsedAt: number;     // 空闲计时基准（每次 use() 刷新）
  state: "warming" | "ready" | "draining" | "disposed";
}

export class EngineLifecycle {
  constructor(opts: {
    systemHome: string;            // HANA_HOME/system
    resolveUserHome: (userId: string) => string;  // ADR-13 布局
    productDir: string;
    appVersion: string;
    builtinMediaAdapters: unknown;
    idleTtlMs?: number;            // 默认 30*60*1000（ADR-12/ADR-5 默认30min）
    onConstruct?: (ctx: { userId: string; engine: HanaEngine; hub: Hub }) => Promise<void>;
    // onConstruct 用于注入 Sandbox Orchestrator、Sharing、Bridge 绑定等（ADR-9/10）
  });

  /** 获取或懒加载某用户 Engine；刷新 lastUsedAt。 */
  async use(userId: string, ctx?: RequestContext): Promise<UserEngineHandle>;

  /** 显式保活（长任务/流式进行中调用，防休眠打断）。 */
  keepAlive(userId: string): void;

  /** 用户注销：软删窗口结束后物理销毁（ADR-12.5）。 */
  async release(userId: string, hard?: boolean): Promise<void>;

  /** 全量排水（server 关闭时）。 */
  async drainAll(): Promise<void>;

  /** 当前活跃实例数（运维/限流观测）。 */
  get activeCount(): number;
}
```

### 8.7.3 生命周期状态机

```
           use(userId)
  [空] ───────────────▶ [warming] ──new HanaEngine+Hub+init──▶ [ready]
                              │                                     │
                              │ 失败(账号不存在/已软删)              │ idleTtlMs 内无 use/keepAlive
                              ▼                                     ▼
                        throw AuthError                         [draining] ──engine.dispose()──▶ [disposed]→GC
                                                                         │
                                                              release(hard) ──▶ 立即 dispose + 清 UserHome
```

- **懒加载**：`use()` 命中缓存直接返回；未命中则 `resolveUserHome(userId)` 取目录 →
  校验 `accounts.status==='active'` → `new HanaEngine({hanakoHome: userHome, ...})` →
  `new Hub({engine})` → `onConstruct` 注入依赖 → `await engine.init()` → 标记 `ready`。
- **空闲休眠**：后台 `setInterval`（如每 60s 扫）对 `ready` 且
  `now - lastUsedAt > idleTtlMs` 的实例调 `engine.dispose()`（停 plugin/mcp/session/store），
  释放内存，数据全在磁盘不丢；实例从池移除，下次 `use()` 重新懒加载（首条消息延迟 1–2s）。
- **保活**：流式响应 / 长任务期间调 `keepAlive(userId)` 推后 `lastUsedAt`，避免对话中途被休眠。
- **销毁**：`release(userId, true)`（注销硬删）立即 dispose 并清 UserHome；软删窗口内不释放，
  待定时任务到期再 `release(hard)`（见 ADR-12.5）。

### 8.7.4 与现有代码的改造映射

| 现有 | 改造后 |
|---|---|
| `server/index.ts` line 437 `new HanaEngine({hanakoHome})` | 移入 `EngineLifecycle` 的 `use()` 构造分支，`hanakoHome`→`resolveUserHome(userId)` |
| `server/index.ts` line 477 `new Hub({engine})` | 同上，随 engine 一起在 `use()` 内构造 |
| `engine.hanakoHome`（全局） | 每个实例指向各自 `users/<userId>` |
| `engine.dispose()`（已存在，line 2665） | 直接作为休眠/销毁实现，无需新增 |
| `ensureLocalIdentityRegistries(hanakoHome)`（line 429，系统级） | 保留在 `HANA_HOME/system`（系统级，非 per-user） |
| `BrowserManager.setHanakoHome(engine.hanakoHome)`（line 456） | 改为 per-user 注入或在 `onConstruct` 内按 userHome 设 |

### 8.7.5 并发与限流约束（ADR-11）
- 构造期间加 per-user 锁（防止并发 `use` 双构造）：`Map<userId, Promise<UserEngineHandle>>` 去重。
- `activeCount` + `idleTtlMs` 配合运维告警；单节点 ≤50 实例（规模上限）。
- 同一 userId 的并发请求共享同一 handle（无需每请求一实例）。

### 8.7.6 开放细节（后续 ADR 展开）
- `onConstruct` 内注入的 Sandbox Orchestrator 接口 → 待 ADR-15（Sandbox 协议）。
- Bridge 按 userId 绑定 token → 待 ADR-9 落地设计。
- `resolveUserHome` 的具体实现 → 复用 ADR-13 的 `HANA_HOME/users/<userId>`。

## 8.8 ADR-15 Sandbox 协议设计（ADR-10 落地）

本 ADR 将"用户自建脚本工具在 OS 级沙箱执行"落为协议契约。基于代码审计：
现有 `lib/sandbox/index.ts` 是**无状态工厂**，`buildSandboxedTools(opts)` 每次 session
创建独立的 PathGuard + OS 沙盒 exec；`bwrap.ts` 已用 argv 数组 spawn `bwrap` 做 Linux 沙盒，
`policy.ts` 是 ACL 单一来源（BLOCKED_FILES / READ_ONLY_HOME_DIRS 等）；`seatbelt.ts` 做 macOS。
改造是**把"本机 spawn"升级为"容器化 executor"**，但复用 `buildBwrapArgs` 作容器内二级隔离。

### 8.8.1 位置与职责
- 新增 `server/sandbox/orchestrator.ts`：`SandboxOrchestrator`，由 `EngineLifecycle.onConstruct`
  注入每个用户 Engine（ADR-14.7.6）。它是**用户工具执行的唯一出口**。
- 复用 `lib/sandbox/*` 作为底层执行底座（PathGuard 根切到 `users/<userId>`，bwrap/seccomp 作容器内二级隔离）。
- **不**让前端/用户直接 exec；所有执行经 `orchestrator.execute()`，便于限额/审计/限流。

### 8.8.2 执行请求协议（Job）

```ts
// server/sandbox/protocol.ts
export type SandboxRuntime = "node" | "python" | "bash";

export interface SandboxJob {
  jobId: string;                 // UUID，便于追踪/限流
  userId: string;                // ADR-4/5：决定挂载哪份 UserHome
  assetId: string;               // 来自 user_assets（ADR-13），溯源审计
  runtime: SandboxRuntime;       // node | python | bash（ADR-12 决议）
  code: string;                  // 用户脚本源码（或工作流展开后的脚本）
  args?: Record<string, unknown>;// 工具参数 schema 的实参
  cwd?: string;                  // 相对用户工作区，默认用户 tools/ 沙箱区
  env?: Record<string, string>;  // 用户注入的环境变量（不含密钥！密钥由挂载注入）
  network: "off" | "allowlist";  // 默认 off；allowlist 需配白名单域名
  networkAllow?: string[];       // 白名单域名（仅 network=allowlist 生效）
  limits?: {
    cpuMillis?: number;          // 默认 2000
    memoryMb?: number;           // 默认 256
    timeoutMs?: number;          // 默认 30000
    maxOutputBytes?: number;     // 默认 1MiB，防输出爆库
  };
  secrets?: {                    // 由 provider_creds 解密后挂载，不进 code/env 明文
    OPENAI_API_KEY?: string;     // 用户自带 Key（ADR-6/12.1）
    OPENAI_BASE_URL?: string;
  };
}
```

### 8.8.3 执行结果协议（Result）

```ts
export interface SandboxResult {
  jobId: string;
  exitCode: number;
  stdout: string;                // 截断到 maxOutputBytes
  stderr: string;
  artifacts?: SandboxArtifact[]; // 产物（写回 UserHome，返回引用，ADR-2 输出物）
  durationMs: number;
  usage: { cpuMillis: number; memoryMbPeak: number; killedBy?: "timeout" | "oom" | "network" };
}

export interface SandboxArtifact {
  path: string;                  // 容器内相对 UserHome 路径
  sizeBytes: number;
  mimeType?: string;
}
```

### 8.8.4 SandboxOrchestrator 接口

```ts
export class SandboxOrchestrator {
  constructor(opts: {
    resolveUserHome: (userId: string) => string;
    image?: string;              // 预装 node+python+bash 的沙箱镜像（ADR-12 运行时）
    defaultLimits?: SandboxJob["limits"];
    onJobStart?: (j: SandboxJob) => void;     // 写 usage_ledger（ADR-11/13）
    onJobEnd?: (j: SandboxJob, r: SandboxResult) => void;
  });

  /** 同步执行（小工具）；返回 Result。超限额抛 SandboxLimitError。 */
  async execute(job: SandboxJob): Promise<SandboxResult>;

  /** 流式执行（长任务）；onData 回调 stdout/stderr，结束 resolve Result。 */
  async executeStream(job: SandboxJob, onData: (chunk: {stream:"stdout"|"stderr"; data:string}) => void): Promise<SandboxResult>;
}
```

### 8.8.5 容器执行底座（复用现有 lib/sandbox）

- **镜像**：Docker 镜像预装 `node`、`python3`、`bash`，并内置 `bwrap`；容器内再套一层
  bwrap/seccomp 作二级隔离（纵深防御）。
- **挂载**：仅挂载 `users/<userId>/`（只读系统区 + 可写 `tools/`/`workflows/`/临时区）；
  其他用户目录、SystemDB **不挂载**（防串号，ADR-4 强制）。
- **密钥注入**：`secrets` 经 Docker `--secret` 或 tmpfs 文件挂载进容器，运行后销毁，
  **不进 code/env 明文、不落日志**（ADR-6 加密链路延续）。
- **联网**：`network:"off"` 时 `--network=none`；`allowlist` 时容器内有 egress 代理仅放行白名单。
- **资源限额**：Docker `--cpus` / `--memory` / `--pids-limit` + 内部 `timeout` 信号；
  OOM/超时 → `killedBy` 标记，Result 仍返回。
- **bwrap 复用**：现有 `buildBwrapArgs(policy, {...})`（`bwrap.ts`）直接作为容器内二级隔离参数，
  `policy.ts` 的 ACL 常量继续作为策略单一来源，PathGuard 根改为 `users/<userId>`。

### 8.8.6 与现有代码改造映射

| 现有 | 改造后 |
|---|---|
| `lib/sandbox/index.ts buildSandboxedTools(opts)` | 保留作底层；`opts.hanakoHome`→`users/<userId>`；新增 `server/sandbox` 做远程/容器封装 |
| `lib/sandbox/bwrap.ts createBwrapExec` | 复用 `buildBwrapArgs` 作容器内二级隔离 |
| `lib/sandbox/policy.ts` 常量 | 继续作为 ACL 单一来源，新增"禁止读其他用户目录/SystemDB"规则 |
| `lib/sandbox/path-guard.ts` | `hanakoHome`→`userHome(userId)` 参数化（ADR-4） |
| `lib/sandbox/win32-*.ts` | 服务器为 Linux，win32 分支不再用于沙箱（仅本地开发回退） |
| `lib/tools/workflow-tool.ts` | 无代码工作流展开后调用 `orchestrator.execute()`（ADR-7） |

### 8.8.7 安全边界清单（ADR-10/12）
1. 每 job 独立容器，互不共享文件系统（仅各自 UserHome 子集）。
2. 默认禁网；联网需显式 allowlist + 审核记录。
3. 密钥不落盘、不进 env 明文、不进 stdout/stderr。
4. 输出截断 `maxOutputBytes`，防爆 UserDB（`usage_ledger`/artifact 引用）。
5. 限额超则 kill 并标记原因；配额超（ADR-11）在 `execute` 前拦截。
6. 用户工具一律进强沙箱；内置/审核工具可走宽松策略（同镜像信任级更高）。

### 8.8.8 开放细节（后续）
- 镜像构建 Dockerfile → 待 `deploy/` 章节。
- 配额（ADR-11）如何在 `execute` 前读取 UserDB `usage_ledger` 做拦截 → 待限流 ADR。
- 容器池化/复用（冷启动优化）→ 性能迭代，首版每 job 起停容器可接受。

## 8.9 ADR-16 分享市场 API 设计（ADR-8C / 12.2 落地）

本 ADR 将"用户间分享工具/Agent/技能/工作流（同实例全员、免审核）"落为 API 契约。
基于代码审计：项目**已有成熟的市场+安装底座**，无需从零——
- `lib/plugin-marketplace.ts`：`PluginMarketplace` 类，从本地 `marketplace.json` 或远程 URL
  加载插件列表/README/distribution（默认 `OH-Plugins` 仓库）。
- `lib/plugin-install-records.ts`：`PluginInstallRecords`，按 `hanakoHome` 存安装记录
  （版本/来源/sha256，旧版历史保留）。
- `server/routes/plugins.ts`：一整套 install/uninstall/sync/backup/restore 路由，
  含 `assertInsideDir` 路径逃逸防护、`MAX_PLUGIN_RELEASE_PACKAGE_SIZE=50MB`、`assertExpectedPlugin` 等。
**设计策略**：把"用户分享"作为**新增一个本地市场源**叠加在现有机制上，复用 `installPluginFromPath`
（已支持从本地路径安装）+ `shared_assets`（ADR-13）作索引，而非另造一套。

### 8.9.1 新增组件
- `server/sharing/index.ts`：`SharingMarket`，封装 `shared_assets` 表的读写，并桥接现有
  `PluginMarketplace`（把 `shared_assets` 动态生成一份本地 `marketplace.json` 视图）。
- 复用 `server/routes/plugins.ts` 的安装管线；新增 `server/routes/sharing.ts` 暴露分享专属端点。

### 8.9.2 数据索引（复用 ADR-13 `shared_assets`）
```sql
-- 已在 ADR-13 定义；补充查询语义：
-- 发布: INSERT INTO shared_assets(asset_id, owner_id, kind, name, origin_ref, visibility, install_count, created_at, system_owned)
-- 发现: SELECT * FROM shared_assets WHERE visibility='instance' [AND kind=?] [AND owner_id!=?] ORDER BY install_count DESC
-- 安装: UPDATE shared_assets SET install_count=install_count+1 WHERE asset_id=?
-- 注销转移: UPDATE shared_assets SET owner_id='__system__', system_owned=1 WHERE owner_id=?  (ADR-12.5)
```

### 8.9.3 分享 REST 端点（server/routes/sharing.ts）

```
POST   /api/sharing/publish        # 发布当前用户的私有资产（user_assets → shared_assets）
GET    /api/sharing/discover       # 列出可安装资产（同实例全员；支持 ?kind=&q= 过滤）
GET    /api/sharing/assets/:id     # 资产详情 + README/描述
POST   /api/sharing/install        # 安装到自己的 user_assets（fork 副本，引用 origin_ref）
DELETE /api/sharing/assets/:id     # 撤回自己发布的资产（仅 owner 或 system_owned 管理员）
GET    /api/sharing/mine           # 列出我发布/我安装的关系
```

### 8.9.4 端点契约（TS 类型）

```ts
// 发布
interface PublishRequest {
  assetId: string;        // 来自调用者的 user_assets（ADR-13）
  visibility?: "instance";// 本方案仅 instance（ADR-12.2）
}
interface PublishResponse { assetId: string; installUrl: string; }

// 发现
interface DiscoverQuery { kind?: "tool"|"skill"|"agent"|"workflow"; q?: string; page?: number; pageSize?: number; }
interface DiscoverItem {
  assetId: string; ownerId: string; ownerHandle: string; kind: string; name: string;
  installCount: number; createdAt: number; forkedFrom?: string; systemOwned: boolean;
}

// 安装（复用现有 installPluginFromPath 管线）
interface InstallRequest { assetId: string; asFork?: boolean; }  // asFork 默认 true（ADR-8B 私有副本）
interface InstallResponse { assetId: string; localAssetId: string; installedVersion: string; }
```

### 8.9.5 与现有代码改造映射

| 现有 | 改造后 |
|---|---|
| `PluginMarketplace`（本地/远程源） | 新增"本地分享源"：由 `shared_assets` 动态生成 `marketplace.json` 视图，注入现有市场加载 |
| `PluginInstallRecords`（按 hanakoHome） | `hanakoHome`→`users/<userId>`（ADR-4）；安装记录自动 per-user 隔离 |
| `server/routes/plugins.ts` installPluginFromPath | 复用：分享安装 = 把 `shared_assets` 指向的资产导出到临时目录后走同一管线 |
| `assertInsideDir` / 50MB 上限 / `assertExpectedPlugin` | 直接复用于分享安装，防路径逃逸与超包 |
| `server/routes/plugins.ts` 的 uninstall/sync | 复用：撤回/更新分享资产 |
| `marketplace.json` 远程默认（OH-Plugins） | 保留为"系统内置市场"；用户分享市场为新增同级源 |

### 8.9.6 安全与一致性约束（ADR-8C / 12.2 / 10）
1. 免审核，但**所有安装的分享资产一律进 Sandbox 强沙箱执行**（ADR-15.7.7）——即使含恶意脚本也只能伤己。
2. 安装即 fork：写入**调用者**的 `user_assets`，`forked_from` 指向 `shared_assets.asset_id`；
   原作者更新不自动覆盖（避免供应链投毒），需用户手动重装。
3. 路径防护：复用 `assertInsideDir`，分享资产解包目标必须落在调用者 `users/<userId>/plugins/` 内。
4. 撤回：仅 `owner_id` 本人或 `system_owned` 管理员可 `DELETE`；撤回后已安装副本不受影响（fork 隔离）。
5. 注销转移：作者注销（ADR-12.5）后，`shared_assets` 转 `system_owned=1`，资产保留供他人继续安装。

### 8.9.7 开放细节（后续）
- 分享资产的内容审核/举报机制 → 首版不做（靠沙箱兜底，ADR-12.2 已决议）。
- 版本更新通知（原作者发新版提醒安装者）→ 性能/体验迭代。
- 跨实例联邦分享（多 server 间）→ 超出本方案范围。

## 8.10 ADR-17 路由层 userId 注入改造（承上启下）

本 ADR 将 ADR-14 的 `EngineLifecycle` 真正接进每个 HTTP/WS handler，是 M0 的核心改造。
基于代码审计：
- `principal` 已携带 `userId`（`web-auth.ts`：`principal.userId = acct.userId`），且
  `server/http/route-security.ts` 的 `classifyHttpRoute` 已按 scope 分级（`chat` /
  `settings.write` / `providers.manage` / `bridge.manage` / `studio_owner`），授权层**基本不动**。
- `server/composition/open-root.ts` 当前把**全局 `engine`** 直接注入每个 route 工厂
  （如 `createWebAuthRoute({hanakoHome: engine.hanakoHome})`、`createServerIdentityRoute`、
  `createSpeechRecognitionRoute(engine)`、`createChatRoute(engine)` 等）。
- WS 已用 `ws-ticket`（`routes/ws-auth.ts`），ticket 的 principal 同样带 `userId`。
- **唯一核心改动点**：把 `open-root.ts` 中所有 `engine` 注入改为注入
  `engineLifecycle`；各 handler 内用 `principal.userId` 经 `lifecycle.use()` 取该用户 Engine。

### 8.10.1 改造模式（单一规则）

```ts
// 改造前（open-root.ts）
app.route("/api", createChatRoute(engine));                 // 全局单例
// 改造后
app.route("/api", createChatRoute({ engineLifecycle }));    // 注入 lifecycle

// 改造前（handler 内）
function handler(c) { const engine = c.get("engine"); ... }
// 改造后（handler 内）
async function handler(c) {
  const principal = readAuthPrincipal(c);       // 已含 userId
  const { engine, hub } = await engineLifecycle.use(principal.userId, c);
  c.set("engine", engine); c.set("hub", hub);
  try { /* ...原有逻辑... */ }
  finally { engineLifecycle.keepAlive(principal.userId); }  // 长任务/流式期间保活
}
```

### 8.10.2 open-root.ts 具体改动清单

| 行（现状） | 现有注入 | 改后 |
|---|---|---|
| L88 `createWebAuthRoute({hanakoHome: engine.hanakoHome,...})` | 全局 engine | `engineLifecycle`；登录后 `lifecycle.use(userId)` 预热 |
| L132 `createServerIdentityRoute({hanakoHome: engine.hanakoHome,...})` | 全局 engine | `engineLifecycle`（identity 按 userId 返回该用户画像） |
| `createChatRoute(engine)` / `createSessionsRoute(engine)` | 全局 engine | `engineLifecycle` |
| `createAgentsRoute(engine)` / `createChannelsRoute(engine)` | 全局 engine | `engineLifecycle` |
| `createModelsRoute(engine)` / `createProvidersRoute(engine)` | 全局 engine | `engineLifecycle`（provider_creds 按 user 取，ADR-13） |
| `createBridgeRoute(engine)` | 全局 engine | `engineLifecycle`（bridge 按 userId 绑定，ADR-9） |
| `createPluginsRoute(engine)` / `createSkillsRoute(engine)` | 全局 engine | `engineLifecycle`（用户私有插件，ADR-8B） |
| `createSharingRoute(...)`（ADR-16） | 新增 | 注入 `engineLifecycle` + `sharingMarket` |
| WS 升级（`/ws`） | 全局 engine | 升级时从 ticket principal 取 `userId` → `lifecycle.use(userId)` |

### 8.10.3 中间件：统一 userId 解析与 Engine 注入

新增 `server/http/user-engine-middleware.ts`，在 `open-root.ts` 挂载为前置中间件，
对**非 PUBLIC** 路由统一执行：
1. `readAuthPrincipal(c)` → 取 `principal.userId`（缺失则 403，由 `route-security` 已判）。
2. `const handle = await engineLifecycle.use(userId, c)`。
3. `c.set("engine", handle.engine)` / `c.set("hub", handle.hub)`。
4. handler 结束后不 dispose（由 idle 定时器管），但长任务调 `keepAlive`。
→ 各 route 工厂**无需逐个改**，只需从 `c.get("engine")` 取（现有代码已如此取）。

### 8.10.4 WS 的 userId 注入

- `ws-auth.ts` 签发 ticket 时 principal 已含 `userId`，ticket 自身携带 userId。
- WS 升级处理器读 ticket → `userId` → `await engineLifecycle.use(userId)` → 该连接后续消息
  全部经该用户 Engine 处理；连接关闭时 `keepAlive` 计时自然续上空闲窗口。
- WS scope 模型（`ws-scope.ts` 已 fail-closed）叠加 `userId` 维度：订阅/资源仅本用户可见。

### 8.10.5 LOCAL_ONLY 路由的处理（Web 多用户安全性）

现有 `classifyHttpRoute` 中 `LOCAL_ONLY`（如 `/api/shutdown`、`/api/access/*`、
`/api/devices/*`、`/api/plugins/install` 本地安装、`/api/skills/external-paths`）：
- Web 多用户版这些**不应被普通用户访问**。改造为：
  - 进程/运维类（`shutdown`/`devices`）→ 新增 `SYSTEM_ADMIN` 级，仅 server 部署者持有
    （env 注入的管理员 principal），普通 `userId` 403。
  - 本地插件/技能路径（`/api/plugins/install` 本地路径安装、`external-paths`）→ 改为经
    `engineLifecycle.use(userId)` 的**用户私有**安装/路径，scope 改 `chat` 或 `settings.write`。
- 见 ADR-12.4：OIDC 留接口，本地 loopback 概念在 Web 版退化为"SYSTEM_ADMIN"。

### 8.10.6 与现有代码改造映射

| 现有 | 改造后 |
|---|---|
| `open-root.ts` 全局 `engine` 注入 | 改注入 `engineLifecycle`，handler 经 `c.get("engine")` |
| `readAuthPrincipal(c)`（`http/capability-guard.ts`） | 复用，已返回含 userId 的 principal |
| `route-security.ts classifyHttpRoute` | 基本不动；`LOCAL_ONLY` 子集改为 `SYSTEM_ADMIN`/用户私有 |
| `routes/ws-auth.ts` issueTicket | 复用，ticket 携带 userId |
| `ws-scope.ts` 订阅模型 | 叠加 userId 维度（资源仅本用户可见） |
| `c.get("engine")` 取值约定 | 沿用，中间件统一 set |

### 8.10.7 风险与守住点
1. **串号防护**：任何 handler 不得缓存跨请求的 engine 引用；必须经 `c.get("engine")`（per-request）。
2. **懒加载延迟**：首请求触发 `use()` 构造 Engine（1–2s），前端首屏需 loading 态（ADR-5/14）。
3. **并发构造**：`lifecycle.use` 内部 per-user Promise 去重（ADR-14.7.5），防热点用户双构造。
4. **保活边界**：流式/长任务必须在 `finally` 或心跳中调 `keepAlive`，否则对话中途被休眠。

### 8.10.8 开放细节（后续）
- `SYSTEM_ADMIN` principal 的签发机制（env 管理员 token）→ 运维 ADR。
- WS 连接的 engine 在用户长时间离线后的回收时序 → 复用 ADR-14 idle 计时。

---

## 8.11 M0 去桌面骨架：代码级改造计划（首个可跑原型）

把 ADR 1–17 收敛为**第一个能跑的多用户 Web 原型**。基于代码审计，项目已有
`dev:web`（server+vite 直连）、`/mobile`+`/desktop` 网页入口、`standalone` server 模式、
`decideMobileStaticRouteOptions`——**Web 前端已能脱离 Electron 构建并由 server 供货**。
故 M0 不是"从零做 Web"，而是"把单用户 dev-web 升级为多用户 server-first 骨架"，
并**弃用全部 Electron 专有构建**（preload/splash/theme/main）。

### 8.11.1 目标（M0 完成定义）
- [ ] 一条命令启动：**server（standalone）+ Web 前端**，无 Electron。
- [ ] 浏览器打开 → 登录/注册页 → 登录后进入 chat。
- [ ] 多用户：A/B 各自 Engine、各自 UserHome、各自 session，互不串号。
- [ ] 登录用户可在设置里填自己的 LLM provider+key+model（单用户自填，暂不做兜底/分享/沙箱）。

### 8.11.2 删除 / 弃用（Electron 专有）

| 文件/脚本 | 动作 | 说明 |
|---|---|---|
| `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/preload.bundle.cjs` | 删除 | 主进程/IPC/preload 全弃 |
| `vite.config.main.js`、`vite.config.preload.js`、`vite.config.splash.ts`、`vite.config.theme.js` | 删除或移出 M0 构建 | Electron 专有产物 |
| `package.json` `scripts.start/start:dev/start:vite/build:client/build:main` | 改/弃 | 不再走 Electron launch |
| `dev-web.js` 中 `server-info.json` 轮询 + `HANA_DEV_WEB_SERVER_TOKEN` | 弱化 | Web 多用户走 cookie 鉴权（ADR-3），token 握手退为可选本地回退 |
| `server/index.ts` 中 desktop 专属逻辑（`HANA_SERVER_OWNER==="desktop"` 分支、detectDataEpochLaunchMarker 文案） | 清理 | standalone 成为唯一模式 |
| `/api/shutdown` 等 LOCAL_ONLY | 改 SYSTEM_ADMIN（ADR-17.10.5） | 防普通用户触达 |

### 8.11.3 新增文件

| 文件 | 职责 | 对应 ADR |
|---|---|---|
| `server/engine-lifecycle.ts` | `EngineLifecycle` 类（ADR-14 全量实现） | 14 |
| `server/http/user-engine-middleware.ts` | 按 `principal.userId` 注入 engine 的前置中间件 | 17 |
| `server/auth/register.ts` | 注册端点（scrypt 哈希，复用 `local-user-account`） | 3 |
| `server/persistence/system-db.ts` | SystemDB（`accounts`/`shared_assets`/`system_config`），better-sqlite3 | 13 |
| `server/persistence/user-db.ts` | UserDB（`provider_creds`/`usage_ledger`/`user_assets`/`user_settings`） | 13 |
| `server/paths.ts` | `resolveUserHome(userId)` / `resolveSystemHome()`，HANA_HOME 布局 | 13 |
| `deploy/Dockerfile`、`deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/nginx.conf` | 部署骨架 | 2 |
| `desktop/src/pages/Login.tsx`（或复用现有 onboarding） | 登录/注册页 | 3 |
| `desktop/src/api/auth.ts` | 登录/注册/登出封装（替代 `window.hana` 相关 IPC） | 1/3 |

### 8.11.4 改造文件（核心三步）

**Step 1 — Server 启动改为多用户骨架（server/index.ts + open-root.ts）**
- `server/index.ts`：移除全局 `new HanaEngine({hanakoHome})`（line 437）+ `new Hub`；
  改为 `const engineLifecycle = new EngineLifecycle({ systemHome, resolveUserHome, ... })`，
  挂到 `app` 上下文。移除 desktop owner 分支。
- `open-root.ts`：所有 `createXxxRoute(engine)` → `createXxxRoute({ engineLifecycle })`；
  挂载 `user-engine-middleware` 前置（`/api` 非 PUBLIC 路由）。
- `app.post("/api/log")` 等内部路由保留（admin 级）。

**Step 2 — 前端去 Electron 依赖（desktop/src）**
- 移除 `window.hana` preload 调用（文件选择/对话框）→ 改用新增 REST 端点（`/api/fs/*` 等）
  或浏览器原生 `<input type=file>` + FormData 上传。
- 新增 `Login.tsx` + 路由：未登录跳 `/login`，登录后拿 cookie，WS 用 `ws-ticket` 换票。
- `vite.config.ts` 增加 PWA 插件位（`vite-plugin-pwa` 留接口，M0 先不强制 SW）。
- 启动方式：复用 `dev:web`，但 `HANA_DEV_WEB_API_BASE_URL` 指向 server，去掉 token 依赖。

**Step 3 — 账号与用户数据打通**
- `server/auth/register.ts`：`POST /api/auth/register`（handle+密码+displayName）→
  scrypt 哈希写 `accounts`；同时 `ensureLocalIdentityRegistries` 在 `users/<userId>/` 建目录。
- `local-user-account.ts`：扩展 `registerAccount` / `softDeleteAccount(deletedAt)` /
  `hardDeleteUser(userId)`（清 UserHome，ADR-12.5）；`defaultUserId` 概念废除（多账号）。
- `web-auth.ts`：登录成功后 `engineLifecycle.use(userId)` 预热（可选）；cookie 已带 userId。
- 模型/provider 设置：`createProvidersRoute({engineLifecycle})` 内从 UserDB `provider_creds`
  读写（M0 先支持单条用户自带 key，兜底留接口）。

### 8.11.5 最小启动命令（M0 期间）

```bash
# 开发
HANA_SERVER_OWNER=standalone npm run dev:web
# 或显式两进程
npm run build:renderer && npm run server   # server 供货 dist-renderer + /api

# 生产（后续 deploy）
docker compose -f deploy/docker-compose.yml up
```
`package.json` 新增：`"web:dev": "HANA_SERVER_OWNER=standalone node scripts/dev-web.js"`、
`"web:start": "npm run build:renderer && npm run server"`。

### 8.11.6 验证清单（M0 验收）
1. 启动无 Electron 进程（`ps` 无 `Electron`/`main.cjs`）。
2. 浏览器开 `/` → 注册账号 A → 登录 → 发消息，生成 `users/A/` 目录与 `user.sqlite`。
3. 退出，注册 B，确认 `users/B/` 独立，且无 `users/A/` 内容泄漏。
4. A 设置自己的 OpenAI 兼容 key+model → 对话走该 provider；B 未设则提示配置（M0 无兜底）。
5. 并发：A、B 同时对话，各自 session 不串（读 `usage_ledger` 分库验证）。
6. 长对话流式期间 Engine 不被休眠（keepAlive 生效）。

### 8.11.7 不在 M0 范围（留给 M1–M5）
- Sandbox 容器化（M3，ADR-15）、分享市场（M4，ADR-16）、Bridge 绑定（M5，ADR-9）、
  PWA 离线/推送（M4）、兜底模型 UI（M5）、限流强制（M2+）。

### 8.11.8 M5 部署与沙箱后端策略（避免 Docker-in-Docker）

M2-3 的 Docker 执行沙盒（每次用户 job 起的临时容器）与 M5 的**应用部署容器**（OpenHanako 整体 image）
是两层独立容器，**不得盲目嵌套为 Docker-in-Docker**：

- **裸金属 / VM 部署**（宿主有 docker daemon）→ M2-3 用 `docker` 执行后端，强隔离。
- **Docker 部署**（应用自身在容器内）→ **锁定 `HANAKO_SANDBOX_BACKEND=bwrap`**（ADR-15 二级隔离），
  不挂载宿主 docker socket、不启用 DinD。`docker-compose.yml` 的 server 服务默认注入该 env。
- 如需在容器内部启用 docker 执行（高级/自托管场景），显式设 `HANAKO_SANDBOX_BACKEND=docker`
  并挂载 `/var/run/docker.sock`（或 rootless docker），由部署者自担攻击面。
- `.env.example` 与 `deploy/` 文档须标注该变量的默认值与安全含义。

---

## 9. 决策完整性声明

截至 ADR-12，方案文档覆盖的 12 项关键决策均已由用户明确拍板，无遗留开放问题。
后续工作可直接进入接口/数据表设计（见里程碑 M0–M5）。
