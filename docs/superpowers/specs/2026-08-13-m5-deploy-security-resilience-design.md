# M5 · 部署 / 安全 / 韧性 — 设计文档

> 规划日期：2026-08-13
> 上游方案：docs/REARCHITECTURE.md（里程碑 M5：Docker 化 + 反代/隧道 + 兜底模型 + 限流；§8.11.7 / §8.11.8）
> 方法：brainstorming skill，已与用户逐项确认核心决策（见 §0 决策记录）。
> 状态：**已实施（implemented, 2026-08-15）**。设计已落地，落地层偏差见 §8 实施回写。
> ADR 引用：ADR-11（按用户 LLM 限流/配额）、ADR-12.1（兜底模型 failover）。

---

## 0. 决策记录（已与用户确认）

通过 ask_followup_question 逐项澄清，M5 核心决策如下：

| # | 议题 | 决策 | 说明 |
|---|------|------|------|
| 1 | 交付切片 | **单一 M5 里程碑** | 4 项（Docker 脚手架 + 密钥静止加密 + 按用户限流 + 兜底 failover）一次性覆盖，交付后整体可部署+安全+韧性达标 |
| 2 | Docker 形态 | **多阶段构建镜像** | Dockerfile 内 `npm ci` + `build:renderer` + `build:server`，产出含自带 node runtime 的镜像；`docker-compose up` 即用 |
| 3 | 加密迁移 | **惰性原地迁移** | 首次启动若检测到 `HANA_MASTER_KEY` 且 catalog 为明文 → 原地加密写盘；未设 key 时保持明文但打印告警。旧明文不被破坏 |
| 4 | 限流策略 | **仅系统级兜底模型限额** | 用户自己添加的模型不限；仅系统级兜底模型通道限额，且按 userId 各自独立累计 |
| 5 | Failover 触发 | **需显式配兜底模型** | 仅当配置了兜底模型才触发 failover；未配置则维持原错误上抛（不静默降级） |
| 6 | Failover 规则 | **LLM 类 retryable:true 三码 + 记录 failover 事件** | 触发精确取 `shared/errors.ts` 中 LLM 类且 `retryable:true` 的严格三码（`LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE`）；**不**泛化为「全部 retryable」（如 `LLM_AUTH_FAILED`/`LLM_SLOW_RESPONSE` 为 `retryable:false`，不触发）；切换动作写入 usage-ledger/audit 便于观测（不强制单次切换上限，不强制自动回切） |

**决策 4 边界澄清**：用户明确"只有兜底 LLM 才限额，用户自己添加的不用限"。即：限流对象 = 系统级兜底模型通道；配额按 userId 各自独立累计（每个用户自己的兜底用量上限），与各自主模型用量无关。兜底模型由管理员在 server 级配置（`HANA_FALLBACK_MODEL` 或配置文件），非用户自填；用户在 settings 中**不**可见/不可改兜底配额。

**决策 6 边界澄清**：failover 不强制"单次切换上限"与"自动回切主模型"——允许实现时在切换逻辑内自然收敛（主→兜底即止，不级联），但 spec 不把"最多 1 次""自动回切"作为验收硬约束。触发条件严格限定 LLM 类 `retryable:true` 三码（Q1 确认）。

---

## 1. 现状盘点（真实代码底数）

通过 code-explorer 子代理核实（4 个并行探查），避免基于虚构符号设计。

### 1.1 已落地（无需重做）
- 多用户 Engine：`server/engine-lifecycle.ts` + `server/composition/user-engine-middleware.ts`（缺失 principal → 401，注入 `c.get("engine")`/`c.get("hub")`）。
- 反代/隧道模型：`server/index.ts` 已支持 `HANA_PORT`/`HANA_RENDERER_DIST`/`HANA_CORS_ORIGIN`；前端产物服务模式已就绪（`server/routes/mobile-static.ts` + `server/composition/open-root.ts`）。
- sandbox 后端锁：`lib/sandbox/docker.ts` 的 `selectSandboxBackend` 已支持 `HANAKO_SANDBOX_BACKEND=bwrap`；容器内 auto 模式自动选 bwrap 规避 docker-in-docker。
- 错误语义：`shared/errors.ts` 已为 LLM 错误定义 `retryable: true`（`LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE`），但未被消费做重试。

### 1.2 M5 真实缺口（需新建/改造）
- **Docker 脚手架**：`deploy/` 目录缺失（`Dockerfile`/`docker-compose.yml`/`.env.example`/可选 `nginx.conf`）。
- **密钥静止加密**：`provider-catalog.json`（`api_key`）+ `auth.json`（OAuth）**明文落盘**；全仓无 AES-GCM / `HANA_MASTER_KEY` / KDF 任何加密设施。落盘收口于 `ProviderCatalogStore.save()`（`core/provider-catalog.ts:156`）与 `auth.json` 写盘；读取收口于 `getCredentials()`/`getAllProvidersRaw()`（`core/provider-registry.ts:1498/1595`）。
- **按用户限流**：`lib/llm/usage-ledger.ts` 是**每实例 JSON 循环缓冲（5000 条）**，**attribution 不含 userId**；无 LLM 限流代码（`search-rate-limiter.ts` 是工具级第三方节流，正交）。
- **兜底 failover**：无运行期 failover；模型选择是同步静态解析（`ExecutionRouter.resolve`/`ModelManager.resolveExecutionModel`）；`provider-registry.ts` `ALLOWED` 白名单（:1718）**无 fallback 字段**；failover 插入点为 `callText` catch（`core/llm-client.ts:697`）与 `promptSession` try（`core/session-coordinator.ts:4967`）。

---

## 2. 设计 §2.1 · Docker 化脚手架（多阶段构建镜像）

### 目标
提供自包含、可一键部署的容器化交付物，使 openhanako 可作为独立服务（替代桌面壳的 server 进程）运行，并保持前端产物由 server 直接服务。

### 真实底数（来自探查）
- Server 入口：`server/main-full.ts`（自举）；`server/index.ts` 仅导 `startServer()`。
- 启动：dev 用 `node scripts/launch.js server`；生产用 `npm run build:server` → `dist-server/{os}-{arch}/`（含自带 node runtime + `bundle/index.js` + `hana-server` wrapper，`scripts/build-server.mjs:20-47`）。
- 前端：`npm run build:renderer` → `desktop/dist-renderer/`（`vite.config.ts:331-333`，`base:'./'`，多 HTML 入口）。
- 关键环境变量：`HANA_PORT`（默认 14500，非 `PORT`）、`HANA_RENDERER_DIST`（已支持，缺失回退 `desktop/dist-renderer`）、`HANA_HOME`（数据目录）、`HANA_TOKEN`（鉴权）、`HANAKO_SANDBOX_BACKEND=bwrap`。
- Node 要求：`>=24.12.0 <25`（原生 type-stripping，无 tsx）。
- 依赖风险：`better-sqlite3`/`node-pty`/`@node-rs/jieba` native 模块 → 容器内需重建 native 或携带 ABI。

### 落点
- 新增 `deploy/Dockerfile`（多阶段）：
  - 阶段 1 `builder`：`node:24-bookworm`，`npm ci` → **构建顺序硬约束**：必须先 `npm run build:renderer`（产出 `desktop/dist-renderer/`）再 `npm run build:server`（否则 `scripts/build-server-runtime-assets.mjs:57` 断言 `desktop/dist-renderer` 就绪失败）。
  - **native 编译工具链（落地补充）**：`better-sqlite3`/`node-pty`/`@node-rs/jieba` 为 native 模块，builder 阶段需预装 `apt-get install -y python3 make g++`（及 `@node-rs/jieba` 所需的 rust 目标或预编译二进制），确保 `npm ci` / `npm run build:server` 期间 native build 成功。
  - 阶段 2 `runtime`：`node:24-bookworm-slim`，从 builder 拷 `dist-server/` 与 `dist-renderer/`；入口 `hana-server`。
  - **renderer 产物路径对齐**：用 `ARG TARGETARCH` 拼出真实产物路径（对应 `scripts/build-server.mjs:42` 把 renderer 拷入 `dist-server/linux-${TARGETARCH}/desktop/dist-renderer`）：
    ```dockerfile
    ARG TARGETARCH
    ENV HANA_RENDERER_DIST=/app/dist-server/linux-${TARGETARCH}/desktop/dist-renderer
    ```
    避免容器内 `open-root.ts:78` 默认 `desktop/dist-renderer` 错位；`mobile-static.ts:32-37` 路径错配→503 fail-fast，故必须显式命中正确路径（文档在 compose/启动日志中提示 503 时优先核对此变量）。
  - **bwrap 容器内方案（决策 6 确认，Q6 选 A 方案 X）**：标准 `node:24-bookworm-slim` 不含 bubblewrap；启用沙箱需：Dockerfile `apt-get install -y bubblewrap`；compose `cap_add: [SYS_ADMIN]` + `security_opt: [apparmor=unconfined]` + 挂载 `/proc`。`lib/sandbox/index.ts:353-362` 在 bwrap 不可用时 fail-closed（不回退 host），故必须装好 bwrap 否则所有 bash 工具被拒。**文档明确警示逃逸风险**：`SYS_ADMIN`+`apparmor=unconfined` 会削弱容器隔离，仅受信任部署启用；默认 `HANAKO_SANDBOX_BACKEND=bwrap`。
- 新增 `deploy/docker-compose.yml`：
  - `hana` 服务：`build: .`、`ports: 14500:14500`、`volumes: ./data:/app/data`、`environment: HANA_HOME=/app/data`、`HANA_TOKEN`、`HANA_MASTER_KEY`（限流/加密用）、`HANA_FALLBACK_MODEL`（failover 用）、`restart: unless-stopped`。
  - **bwrap 安全声明（落地补充）**：compose 注释或 `deploy/README.md` 明确标注 `cap_add:[SYS_ADMIN]`+`security_opt:[apparmor=unconfined]` 的逃逸风险；并提供**关闭沙箱的纯 trusted-host 备选配置**（`HANAKO_SANDBOX_BACKEND=host` 或移除 cap），供不受信多租户之外场景使用。
  - 可选 `nginx` 服务（注释示例）：反代 `/` → `hana:14500`，启用 TLS/websocket upgrade；对应 `deploy/nginx.conf` 占位（注释形态，非强制）。
- 新增 `deploy/.env.example`：列出 `HANA_PORT` / `HANA_HOME` / `HANA_TOKEN` / `HANA_MASTER_KEY` / `HANA_FALLBACK_MODEL` / `HANAKO_SANDBOX_BACKEND` 及说明。
- **不**改动 server 启动链路（`HANA_RENDERER_DIST` 已支持）；仅在 compose 中正确注入。

### 验收
- `docker compose build` 成功产出镜像；`docker compose up` 后 `GET :14500/` 返回前端页面（mobile/desktop 入口）。
- 容器内 `hana-server` 进程正常监听 `HANA_PORT`，data 持久化到挂载卷。

---

## 3. 设计 §2.2 · 密钥静止加密（HANA_MASTER_KEY + AES-256-GCM）

### 目标
provider api_key / OAuth token 落盘时加密，杜绝明文文件泄露风险。开发态（无 key）保持明文并告警，不破坏已有部署。

### 真实底数（来自探查）
- 写入收口：`ProviderCatalogStore.save()`（`core/provider-catalog.ts:156`，调用 `writeSecretFileSync` → `shared/secret-fs.ts:108` 仅 chmod 0o600）。OAuth 落盘：`core/oauth-force-refresh.ts:51-76`（`auth.json` 明文）。
- 读取收口：`getCredentials()`（`core/provider-registry.ts:1498`）/`getAllProvidersRaw()`（:1595）/`_authJsonCache` 解析（:1552）。这两处是 LLM client 取 key 的唯二真相源。
- 需脱敏字段集合可复用 `shared/secret-custody.ts` 的 `DEFAULT_SECRET_KEYS`（api_key/apiKey/secret/token 等）。
- env 读取范式：`server/index.ts` 启动早期已读 `HANA_HOME`/`HANA_TOKEN` 等（`process.env.*`），挂 `HANA_MASTER_KEY` 无架构障碍。

### 落点
- 新增 `shared/encryption.ts`：
  - `getMasterKey()`：读 `process.env.HANA_MASTER_KEY`；支持 base64/hex/raw；返回 32 字节 key。未设返回 `null`。
  - **密钥派生（KDF，落地补充）**：`HANA_MASTER_KEY` 可能是任意长度口令（如 `my-secret-pass`）而非恰好 32 字节。统一经 `crypto.createHash("sha256")` 或 HKDF 派生为固定 32 字节密钥，避免 AES-256 因 key 长度非 32 字节抛错。即：`getMasterKey()` 内部对原始输入做 SHA-256 标准化后再用作 AES key，调用方无需关心 key 原始形态。
  - `encryptSecret(plain: string): string`：AES-256-GCM，输出 `base64(iv | tag | ct)` 结构，前缀 `enc:v1:` 标记。
  - `decryptSecret(cipher: string): string`：识别 `enc:v1:` 前缀则解密，否则原样返回（兼容明文）。
  - `isEncrypted(value): boolean`。
- 写入侧改造：
  - `ProviderCatalogStore.save()`（`core/provider-catalog.ts`）写盘前对 `DEFAULT_SECRET_KEYS` 命中字段加密（仅当 `getMasterKey()` 非空）。
  - `auth.json` 写盘处（`core/oauth-force-refresh.ts`）对 `access`/`refresh` 加密。
- 读取侧改造：
  - `getCredentials()` / `getAllProvidersRaw()`（`core/provider-registry.ts`）对命中字段 `decryptSecret`。
  - `_authJsonCache` 解析处同样解密。
- **收口约束（Q3 确认，3 条硬约束）**：
  - **(a) 唯一解密点**：所有 secret 读取经 `getCredentials()` / `getAllProvidersRaw()` / `_authJsonCache` 唯一链（已核实无旁路），解密逻辑只在此处；禁止在别处散落 `decryptSecret` 调用。
  - **(b) 惰性加密写回**：`ProviderCatalogStore.load()`（读取时）若 `getMasterKey()` 非空且命中字段仍为明文 → 原地加密并 `save()` 写回（与启动时迁移等价，覆盖运行期新增明文条目）。**防并发写回**：写回前打 `migrating` 标记，避免同一请求周期内对同一条目重复写盘；写回完成即清除标记。
  - **(c) OAuth 刷新收口**：`core/oauth-force-refresh.ts` 内 refresh_token 先 `decryptSecret` 再用于刷新；刷新后写回前先 `encryptSecret`（防止明文落盘）。
- 惰性迁移（决策 3）：
  - 启动时若 `getMasterKey()` 非空且 catalog 含明文 secret → 原地加密并写盘（挂 `core/migrations.ts` 迁移序列或 engine init 钩子）。
  - 若 `getMasterKey()` 为空 → server 启动不失败，打印 `WARN` 提示明文落盘风险（含何设置 `HANA_MASTER_KEY`）。
- **不**修改 `secret-custody.ts` 的脱敏逻辑（仅复用其键集合）。

### 验收
- 设 `HANA_MASTER_KEY` 后，磁盘 `provider-catalog.json` 中 `api_key` 为 `enc:v1:...`；LLM 调用正常（读取侧解密生效）。
- 未设 key 启动：日志出现明文告警，旧明文 catalog 仍可正常加载（向后兼容）。
- 迁移测试：明文 catalog 在设 key 重启后变为加密，且功能无回归。

---

## 4. 设计 §2.3 · 按用户 LLM 限流/配额（仅系统级兜底模型）

### 目标（ADR-11）
仅对**系统级兜底模型通道**按 userId 独立累计用量（token/cost），超额拦截。用户自己添加的模型不受影响。

### 真实底数（来自探查）
- `lib/llm/usage-ledger.ts`：每实例 JSON 循环缓冲 5000 条，**attribution 不含 userId**；`normalizeEntry`（`usage-context.ts:27-32`）= `kind/agentId/sessionId/sessionPath/...`。
- 记账分散在：`core/session-coordinator.ts:556-589`（`recordAssistantUsage`）、`core/llm-client.ts:560/689/700`、`lib/llm/session-snapshot-side-task-runner.ts`。
- 中间件范式：`server/index.ts` 在 `userEngineMiddleware`（`server/composition/user-engine-middleware.ts:12`）之后、`registerClosedRoutes` 之前可 `app.use("*", quotaMiddleware(...))`；`readAuthPrincipal(c).userId` 已就绪；超额拒绝复用 `c.json({error},403)` 范式。
- 限流对象明确：系统级兜底模型（管理员配置），非用户模型。

### 落点
- **userId 维度补齐**：
  - `usage-context.ts` attribution 增加 `userId` 字段；`normalizeEntry` 透传。
  - `recordAssistantUsage`（`core/session-coordinator.ts:567-572`）与 `callText`（`core/llm-client.ts`）记账时填入 `principal.userId`（从 engine/usageContext 注入）。
  - `usage-ledger.ts` `matchesFilter` 增加 `userId` 过滤（L240-255）。
- **配额累计层（新建）**：
  - 新增 `lib/llm/quota-ledger.ts`：`createQuotaLedger({ storagePath, getQuotaForUser })`：
    - 按 `(userId)` 累计兜底模型通道的 token 与 cost（独立 store，非复用 usage-ledger 循环缓冲）。
    - `recordFallbackUsage(userId, {tokens, cost})` / `getUsage(userId)` / `isOverQuota(userId)`。
    - 落盘 JSON（每 hanakoHome 一个 `quota-ledger.json`），避免循环缓冲丢失累计。
  - 兜底模型识别：从 `HANA_FALLBACK_MODEL`（或配置）解析出 `{provider, id}`，记账/拦截时比对 model 引用。
- **配额默认值**：管理员 server 级配置（ENV `HANA_FALLBACK_QUOTA_DAILY_TOKENS` / `..._COST`），无用户自改 UI（决策 4 边界：用户在 settings 不可见兜底配额）。
- **每日重置语义与时区（Q7 确认）**：
  - **单实例假设**：无现成每日重置逻辑，REARCHITECTURE.md 未提多实例；本 M5 声明**单实例**前提（多实例部署下累计不准，文档明确标注为已知限制）。
  - **逻辑日边界**：复用既有 `getLogicalDate`（见 `current-status-tool.ts:19-67`、`shared/config-schema.ts:28`）的 **04:00 起算逻辑日** 规则；`quota-ledger` 按「逻辑日 + userId」分桶累计，跨逻辑日自动重置。
  - **时区**：server ENV `HANA_QUOTA_TZ`（默认 `UTC`）驱动逻辑日边界计算；与用户 preferences 的 `getTimezone()` 解耦（server 级统一时区）。
  - 不引入 cron/定时器，重置在 `getUsage`/`isOverQuota` 读取时按当前逻辑日惰性判定。
- **拦截点（新建函数，非全局中间件）**：
  - **关键底数（Q2 确认）**：Chat 主路径走 WebSocket（`server/routes/chat.ts:1770` `upgradeWebSocket`），消息在 `onMessage`（:1801）处理，**绕过** `app.use("*")` 全局中间件链，故全局 HTTP 中间件对 Chat 无效。
  - 新增 `lib/llm/quota-ledger.ts` 导出 `checkLlmQuota(userId, modelRef): { ok: boolean; reason?: string }`：当 `modelRef` 为系统兜底模型且 `isOverQuota(userId)` → `{ ok:false, reason:"quota_exceeded" }`；否则 `{ ok:true }`。用户自添模型一律放行（决策 4）。
  - 在两处**实际入口**调用（非中间件）：
    - **Chat 入口**：`server/routes/chat.ts` `onMessage`（:1801）内、调用模型前先 `checkLlmQuota(principal.userId, modelRef)`；超额则经 WS 回写错误帧（不调底层 LLM），等效 429 语义。
    - **utility 入口**：`core/llm-client.ts` `callText`（L401）进入时先 `checkLlmQuota(...)`；超额则抛 `quota_exceeded` 等价错误（复用 `SearchRateLimitError` 风格 429）。
  - **不**在 `server/index.ts` 挂载全局 `quotaMiddleware`（对 Chat 无效，且会误伤非 LLM 路由）。
- **记账联动**：`callText` 与 `promptSession` 在兜底模型请求成功/失败时调用 `quotaLedger.recordFallbackUsage`（与 failover 共用兜底识别）。

### 验收
- 对兜底模型发起超额请求 → 返回 429 `quota_exceeded`，且不调用底层 LLM。
- 对用户自添模型发起任意量请求 → 不受限。
- quota-ledger.json 按 userId 累计真实兜底用量；重启后累计保留。

---

## 5. 设计 §2.4 · 兜底模型 Failover（需显式配 + retryable 触发 + 记录）

### 目标（ADR-12.1）
用户/管理员显式配置兜底模型后，主模型在运行期发生 **LLM 类 `retryable:true` 严格三码** 错误时，自动切换到兜底模型重试；切换动作记录在 usage-ledger/audit。未配兜底则不降级。

### 真实底数（来自探查）
- 模型选择静态：`ExecutionRouter.resolve`（`core/execution-router.ts:128`）→ `ModelManager.resolveExecutionModel`（`core/model-manager.ts:457`）→ `resolveModelWithCredentialsFresh`（:659）。
- 两条通道：Chat 主路径（Pi SDK `session.prompt()`，`core/session-coordinator.ts:4967`）；utility（`core/llm-client.ts` `callText` L401）。
- 错误：`shared/errors.ts:14-18` 已定义 LLM 类 `retryable: true` 严格三码（`LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE`）；`LLM_AUTH_FAILED`(401)/`LLM_SLOW_RESPONSE` 为 `retryable:false`，**不**触发 failover（决策 6 精确化，Q1 确认）。
- 无 fallback 字段：`provider-registry.ts` `ALLOWED`（:1718）白名单不含 fallback；`session-coordinator.ts:527-564` 的 `resolveAssistantUsageModel(fallbackModel)` 是 cost 会计回退，非执行期。

### 落点
- **配置字段**：
  - 系统级兜底：`HANA_FALLBACK_MODEL`（compose 注入），解析为 `{provider, id}` 引用；无 UI（决策 5：需显式配，但由管理员配）。
  - （可选扩展）per-model fallback：在 `provider-registry.ts` `ALLOWED`（:1718）加入 `fallbackModel` 字段白名单，允许 model 条目自带兜底引用；本 M5 至少落地系统级。
- **failover 触发判定（新建）**：
  - `lib/llm/failover.ts`：`shouldFailover(err): boolean` → 检查 `err.code` 是否属 **LLM 类且 `retryable:true` 严格三码**（`LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE`，决策 6 精确化；不泛化全集）；并返回配置的兜底引用（若有）。
  - `resolveFallbackModelRef(config)`：从 `HANA_FALLBACK_MODEL` 解析。
- **兜底模型合法性校验与解析缓存（Q4 确认，硬约束）**：
  - **启动期 fail-closed 校验**：engine 初始化时调用 `model-manager.ts:457 resolveExecutionModel` 解析 `HANA_FALLBACK_MODEL`；若解析失败（引用不在 `_availableModels`）→ 抛 `error.modelNotFound`（非 retryable），server **ERROR 拒绝启用 failover / 启动失败**，避免「配错兜底比不配更糟」。
  - **运行期缓存**：校验通过后缓存 `fallbackModelResolved`（解析结果），运行期复用，避免每次请求重解析。
  - **限流复用同一解析**：§4 限流的 `isFallbackModel(modelRef)` 复用 `fallbackModelResolved` 同一解析结果，保证「限流对象识别」与「failover 目标」指向完全一致的系统兜底模型。
- **utility 通道 failover**：
  - 在 `callText`（`core/llm-client.ts:697` catch）包一层：捕获 `retryable` AppError → 若有兜底且未达切换上限 → `resolveModelWithCredentialsFresh(fallbackRef)` → 重试一次 `callText`；记录 failover 事件。
  - **配额边界（Q8 选 B2）**：进入 `callText` 时已查主模型配额（实际仅兜底模型受系统配额限制，见 §4 `checkLlmQuota`）；在发起 failover 重试**前**再查一次兜底配额（`checkLlmQuota(userId, fallbackRef)`），超额则抛 429 `quota_exceeded` 而非继续切换。单层切换（主→兜底即止），无级联重试，故**无死锁**。
- **chat 通道 failover**：
  - 在 `promptSession`（`core/session-coordinator.ts:4967` try）捕获 `retryable` 错误 → `resolveExecutionModel(fallbackRef)` → `runtimeSession.setModel(fallbackModel)` → 重试 prompt；记录 failover 事件。
  - **配额边界（Q8 选 B2）**：同 utility 通道——`onMessage` 进入时已查主配额；切兜底 prompt **前**再查兜底配额，超额则经 WS 回写 429 错误帧。
  - **流式中途失败的状态清理（落地补充）**：Pi SDK 流式输出一半时若发生 `LLM_TIMEOUT`，session 内部 message 列表可能已挂上半截 assistant 消息。切到兜底重试**前**必须先清理该残缺 turn 状态（移除未完成的 assistant 消息片段），以 clean context 重新向 fallback model 发起 prompt，避免把残片当作历史上下文污染重试。
  - **切换作用域（落地补充）**：failover 仅作用于**当前失败的这一个 turn**（单次重试），**不**永久覆写用户在 session 中设置的主模型；重试结束后 session 的 default model 仍恢复为用户原有选择（兜底覆写为临时、turn 级生命周期）。
- **failover 事件记录**：
  - 复用 `usage-ledger.record`（带 `metadata.kind="failover"`、`from`/`to` model、`errorCode`），或写 `core/security-audit-log.ts`（审计日志）；便于观测主→兜底切换频次与原因。
- **不**强制单次切换上限/自动回切（决策 6 边界），但实现层应在重试循环内自然收敛（如最多切到兜底即止，不级联）。

### 验收
- 配 `HANA_FALLBACK_MODEL` 且主模型返回 429/超时/空响应（严格三码）→ 自动用兜底模型返回结果，usage-ledger 出现 `failover` 事件记录。
- 配兜底但主模型返回 `LLM_AUTH_FAILED`（非 retryable）→ 不切换，原错误上抛。
- 未配 `HANA_FALLBACK_MODEL` → 任何主模型错误均原样上抛（不静默降级）。
- 用户自添模型无兜底配置 → 不受 failover 影响。
- **B2 配额边界**：failover 切兜底前若兜底配额超额 → 返 429 `quota_exceeded`（不切换），且单层切换无死锁。
- **启动期校验**：`HANA_FALLBACK_MODEL` 指向不存在的模型 → server 启动 ERROR 拒绝启用 failover。

---

## 6. 跨项依赖与实现顺序

1. **Docker 脚手架**（独立，可最先）：`deploy/` 目录，不依赖其他三项代码改动。
2. **密钥加密**（独立）：`shared/encryption.ts` + catalog/auth 读写改造 + 惰性迁移。
3. **限流**：依赖 usage-ledger 补 userId（§4）；依赖 `HANA_FALLBACK_MODEL` 识别兜底通道（与 §5 共用配置）。
4. **Failover**：依赖 `HANA_FALLBACK_MODEL` 配置 + `retryable` 错误语义（已存在）。

**共享锚点**：`HANA_FALLBACK_MODEL` 同时驱动限流对象识别（§4）与 failover 目标（§5）；`HANA_MASTER_KEY` 驱动加密（§3）；`userId` 维度补齐（§4）是限流前置。

---

## 7. 自审门（design → writing-plans）

- [ ] 四项均落在真实代码收口点（已通过 code-explorer 核实，非空想符号）。
- [ ] 决策 4（仅兜底限额）/ 决策 5（需显式配）/ 决策 6（LLM 类 retryable 三码 + 记录）边界已在 §3-§5 明确。
- [ ] Docker 不改动 server 启动链路（`HANA_RENDERER_DIST` 已支持）；构建顺序硬约束 + `ARG TARGETARCH` 路径 + bwrap 容器内方案 X（Q5/Q6 已落地）。
- [ ] 加密向后兼容（无 key 明文告警，惰性迁移不破坏旧数据）；收口 3 约束（唯一解密点 / 惰性加密写回 / OAuth 刷新解密）已明确（Q3）；**KDF 派生（任意长度 key→SHA-256 32B）+ 惰性写回防并发标记** 已补充（评估微调）。
- [ ] 限流不误伤用户自添模型；拦截点改为 `checkLlmQuota` + Chat `onMessage` / `callText` 双入口，弃用全局中间件（Q2）；时区 `HANA_QUOTA_TZ` + 逻辑日 04:00（Q7）。
- [ ] failover 不静默降级（未配兜底则上抛）；启动期 fail-closed 校验 + `fallbackModelResolved` 缓存 + `isFallbackModel` 复用（Q4）；**流式中途失败 turn 状态清理 + 切换仅作用于当前 turn（不覆写 session 主模型）** 已补充（评估微调）。
- [ ] quota/failover 记账边界 B2：进主查主配额、切兜底前再查兜底配额、超额 429、单层无死锁（Q8）。
- [ ] Docker：构建顺序硬约束 + `ARG TARGETARCH` 路径 + bwrap 容器内方案 X（Q5/Q6）；**native 编译工具链（python3/make/g++）+ compose 安全声明/关闭沙箱备选** 已补充（评估微调）。
- [ ] 待用户审阅后转 writing-plans 拆解实现任务。

---

## 8. 实施回写（2026-08-15 落地后补记）

> 业务语义与设计决策（§0–§7）全部保留。以下为落地层与原始设计的偏离，供后续维护者对齐真实代码。

### 8.1 配额边界最终机制（Q8=B2）
- **主查点（Chat 入口）**：`server/routes/chat.ts` `onMessage` 在 `h.send` 前、`try{` 之前，取 `eng = ws.engine ?? engine`（`chat.ts:1831`）→ `eng.getSessionByPath(promptSessionPath)?.model` → `getQuotaChecker()(userId, sessionModel)`；超额则发 WS `error` 帧 `quota_exceeded` 并 `return`，不进入 prompt。
- **兜底查点（callText 全局）**：`core/llm-client.ts` 模块级 `_quotaChecker`（经 `setQuotaChecker` 注入 `QuotaLedger.checkLlmQuota`）；`callText` 入口查主配额、failover 重试前由 `resolveFallback` 回调再次查兜底配额（经 `engine.resolveModelWithCredentialsFresh` 重解析凭据后递归一次）。单层切换，无死锁。
- 逻辑日：`QuotaLedger.logicalDateKey()` 自含「04:00 起算 + `HANA_QUOTA_TZ`（默认 UTC）」，**不**复用 `lib/tools/current-status-tool.ts` 的 `getLogicalDate`（避免跨模块耦合）。

### 8.2 Failover 插入点的最终落地
- **非** `callText` catch 直改：因 `callText` 自身不解析凭据，改为加可选 `CallTextOptions.resolveFallback(err)` 回调，由上游 `engine.resolveModelWithCredentialsFresh`（`engine.ts:2344`，返回 snake_case `api_key`/`base_url`）注入凭据重解析后递归 `callText` 一次；凭据字段须映射为 camelCase（`apiKey`/`baseUrl`）。
- **Chat 通道（§5 主路径）**：`core/session-coordinator.ts` 的 `promptSession` 不直接调 `callText`（经 `entry.session.prompt` 流式），故新增私有 `_promptWithFallback(entry, text, promptOpts)`：catch 内 `shouldFailover(err)` 命中且 `isFallbackEnabled()` → `session.setModel(fb)` + 覆写 `entry.modelId/modelProvider` → 单次重试 → `finally` 还原三处为原始主模型（仅当前 turn 临时覆写，不污染用户配置）。
- 流式半截 assistant 消息清理依赖 `session.prompt` 失败回滚（未强制显式 abort），代码注释已说明。

### 8.3 加密收口的最终落点
- 写入侧唯一收口：`ProviderCatalogStore.save()`（`provider-catalog.ts`）经 `encryptSecretFields`（按 `DEFAULT_SECRET_KEYS` 递归）加密；OAuth `rotateOAuthCredential` 的 `withLockAsync` 回调内（~:55 读前解密、~:66 `decryptSecret(cred.access) !== staleApiKey` 快速路径比对、~:71 写前加密）。
- 读取侧唯一收口：`provider-registry.ts` 的 `decryptSecretFields`（`getCredentials`/`getAllProvidersRaw`/`_readOAuthEntry` 共用）。
- 惰性迁移：进程内 boolean `_migrating`（非持久化）防并发重入；`getMasterKey()` 非空且 `hasPlaintextSecret` → 加密并写回。

### 8.4 实现约束与已知限制
- 全部编辑经 `read_lints` 通过；`encryption.ts`/`quota-ledger.ts` 经隔离脚本行为验证。
- 单实例前提已在 `quota-ledger.ts` 声明：多实例部署累计不准为已知限制（决策外，Out of Scope）。
- 新测试 `tests/encryption.test.ts`、`tests/quota-ledger.test.ts`、`tests/failover.test.ts` 已随代码提交。
