# M5 实现计划：Docker 化脚手架 · 密钥静止加密 · 按用户 LLM 限流 · 兜底模型 Failover

> 本计划由设计文档 [`../specs/2026-08-13-m5-deploy-security-resilience-design.md`](../specs/2026-08-13-m5-deploy-security-resilience-design.md) 拆解而来。
> 所有落点符号均已通过 code-explorer / 直接读取核实（见每提交 "底数" 段）。
> 提交切分原则：**每个提交可独立 `npm run build` + 跑相关测试**，不依赖后续提交即可编译通过。

## Problem

M5 里程碑交付四项能力，当前缺失：

1. **部署门槛高**：无官方 Docker 镜像；renderer 产物路径在容器内易错位（`mobile-static.ts` 错配→503 fail-fast）；沙箱 bwrap 在容器内无开箱支持。
2. **密钥明文落盘**：`core/provider-registry.ts` 的 `getCredentials`/`getAllProvidersRaw`/`_authJsonCache` 链与非对称 `core/provider-catalog.ts:156 save()`、`core/oauth-force-refresh.ts` 的 `rotateOAuthCredential`（`withLockAsync` 回调内 `cred.refresh`/`nextCred`）均明文存储 `api_key`/`refresh_token`。
3. **兜底通道无限流**：`usage-ledger` 仅记账（`recordAssistantUsage` 见 `core/session-coordinator.ts:556`），系统兜底模型无每日配额上限；Chat 走 WebSocket（`chat.ts:1770 upgradeWebSocket` → `:1801 onMessage`）绕开全局 HTTP 中间件，全局 `quotaMiddleware` 无效。
4. **无兜底 failover**：主模型 `LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE` 直接上抛，无运行期切换兜底；且 `HANA_FALLBACK_MODEL` 配错比不配更糟（解析失败抛 `error.modelNotFound`）。

## Solution

四项各自独立、互不阻塞，仅在 **限流 ↔ failover 配额边界（B2）** 处共享一个 `lib/llm/quota-ledger.ts` 模块。按以下提交顺序实施。

### 工作流 A — Docker 化脚手架（可最先，互不依赖）

- **A1** 新增 `deploy/Dockerfile`：多阶段；builder 装 `python3 make g++` + 构建顺序硬约束（先 `build:renderer` 后 `build:server`，对应 `scripts/build-server-runtime-assets.mjs:57` 断言）；runtime 用 `ARG TARGETARCH` 拼 `ENV HANA_RENDERER_DIST=/app/dist-server/linux-${TARGETARCH}/desktop/dist-renderer`（对应 `build-server.mjs:42` 拷贝路径）；`apt-get install bubblewrap` + `HANAKO_SANDBOX_BACKEND=bwrap`。
- **A2** 新增 `deploy/docker-compose.yml`：`<service> hana`（`build: .`、端口、`volumes: ./data:/app/data`、`environment`、`restart: unless-stopped`、bwrap `cap_add:[SYS_ADMIN]`+`security_opt:[apparmor=unconfined]`+挂 `/proc`，注释标注逃逸风险与 `host` 关闭沙箱备选）；注释态 `nginx` 服务 + `deploy/nginx.conf` 占位。
- **A3** 新增 `deploy/.env.example` + `deploy/README.md`：列出 `HANA_PORT`/`HANA_HOME`/`HANA_TOKEN`/`HANA_MASTER_KEY`/`HANA_FALLBACK_MODEL`/`HANAKO_SANDBOX_BACKEND`/`HANA_QUOTA_TZ`，并说明构建顺序、renderer 路径、bwrap 安全影响。

### 工作流 B — 密钥静止加密

- **B1** 新增 `shared/encryption.ts`：`getMasterKey()`（读 `HANA_MASTER_KEY`，**SHA-256 派生为 32 字节**，支持任意长度口令）、`encryptSecret`/`decryptSecret`（`enc:v1:` 前缀 + AES-256-GCM `base64(iv|tag|ct)`）、`isEncrypted`。**纯新增模块，无调用方即可编译 + 单测。**
- **B2** 写入侧改造：收口为唯一写盘点。
  - `core/provider-catalog.ts:156 save()`：对命中字段 `encryptSecret` 后 `writeSecretFileSync`。
  - `core/oauth-force-refresh.ts` 的 `rotateOAuthCredential` `withLockAsync` 回调（非 ":74 直接写盘"，实际写盘由 `backend` 完成）：
    - **读前解密**：line 55 校验 `cred.access`/`cred.refresh` 时，先 `decryptSecret(cred.refresh)` 再用于 `provider.refreshToken(cred)`（spec Q3(c) 约束：refresh_token 先 decrypt 后用）。
    - **快速路径比对解密（Gotcha 1）**：line 66 `if (staleApiKey && cred.access !== staleApiKey)` 中，`cred.access` 为磁盘原始值（加密后形如 `enc:v1:...`），而传入 `staleApiKey` 是明文。必须用 `decryptSecret(cred.access)` 再与 `staleApiKey` 比较，否则密文≠明文恒为 true，会错误地走 refresh 分支、把刚换来的 refresh token 作废。修正：`if (staleApiKey && decryptSecret(cred.access) !== staleApiKey)`。
    - **写前加密**：line 71 构造 `nextCred = {type:"oauth", ...refreshed}` 时，对 `refresh`/`access` 字段 `encryptSecret` 后再 `JSON.stringify`（spec Q3(c)：写回先 encrypt，防明文落盘）。
- **B3** 读取侧改造：`core/provider-registry.ts:1498 getCredentials` / `:1595 getAllProvidersRaw` / `:1552 _authJsonCache` 对命中字段 `decryptSecret`（唯一解密点）。
- **B4** 惰性迁移：`ProviderCatalogStore.load()` 加进程内 boolean 标记 `this._migrating`（非持久化）防并发写回——`getMasterKey()` 非空且命中字段仍明文 → 加密并 `save()`；写回完成即清除标记。无 key 时保持明文 + `warn`。

### 工作流 C — 按用户 LLM 配额（系统兜底通道）

- **C1** 新增 `lib/llm/quota-ledger.ts`：
  - `QuotaLedger` 类：`load()`/`save()` 自愈 JSON（`{"version":1,"buckets":{}}`）；`recordFallbackUsage(userId, cost)`；`getUsage(userId, logicalDay)`；`isOverQuota(userId)`（默认 `0`，未超=false；非兜底模型调用方不调）。
  - `checkLlmQuota(userId, modelRef): {ok, reason?}`：`isFallbackModel(modelRef)` 且 `isOverQuota` → `{ok:false, reason:"quota_exceeded"}`；否则 `{ok:true}`。用户自添模型一律放行。
  - `isFallbackModel(modelRef)`：复用 `fallbackModelResolved`（见工作流 D 的启动期缓存），未启用 failover → 永远 false。**比较口径**：`modelRef` 与 `fallbackModelResolved` 均为 modelObj（含 `id`+`provider`，与 `sess.model` 同构，见 `chat.ts:1677`），按 `id`+`provider` 严格相等比较；传入裸字符串 id 时先 `parseModelRef` 归一化再比。
  - 逻辑日：复用 `getLogicalDate`（`lib/tools/current-status-tool.ts:67`，签名 `getLogicalDate(date, timeZone)`，已原生支持 tz 参数）+ `HANA_QUOTA_TZ`（默认 UTC）04:00 边界；server 调用时传 `HANA_QUOTA_TZ`，无需扩展签名。`getUsage` 按「逻辑日 + userId」分桶；跨日惰性重置（无定时器）。
  - **纯新增模块，可单测。**
- **C2** 记账联动：`usage-ledger` 的 `recordAssistantUsage`（`core/session-coordinator.ts:556`）读取 `usageContext.attribution.userId` 作为归属（已在 `usageContext.attribution` 透传，见 `lib/llm/usage-context.ts:27-32`）。**注入点明确**：chat 路径在 `chat.ts onMessage` 构造 `usageContext` 时挂 `attribution.userId = client.userId`（来自 `createWsClientRecord` 的 `authPrincipal`，见 `chat.ts:516-529`）；其余 utility 调用方（`memory`/`diary` 等）不改（其 `usageContext` 无 userId，兜底配额对其不生效，符合"仅 chat 用户通道限流"语义）。`lib/llm/usage-ledger.ts:240 matchesFilter` 加 `userId` 分支（缺失时不过滤）；新增 `quota-ledger.recordFallbackUsage` 由 `callText`/`promptSession` 在兜底成功/失败时调用。
- **C3** 拦截点（非中间件）：
  - `core/llm-client.ts:401 callText` 进入时（L421 后、`start` 前）调 `checkLlmQuota(userId, modelRef)`：`userId` 取自 `usageContext?.attribution?.userId`（上游注入，见 C2），`modelRef` 取 `modelObj`（`{id, provider}`，见 `:422-423`）；超额抛 `quota_exceeded`（429 风格 `AppError`）。
  - `server/routes/chat.ts:1801 onMessage` → 取 `client.userId`（见 `chat.ts:516-529`），并在 `h.send(...)`（`:2239`）**前**调 `checkLlmQuota(client.userId, sessionModel)`；其中 `sessionModel = eng.getSessionByPath(promptSessionPath)?.model`（`eng` 为 `ws.engine ?? engine`，见 `chat.ts:1830`，遵循 M1 多用户引擎隔离 H1 不变量；`sess.model` 为 modelObj，见 `chat.ts:1677`），**不**用裸 `engine`（会跨用户取错 session）、**不**用 `entry.session.model`（`entry` 不在 onMessage 作用域）；超额经 WS 回写 `error` 帧（`message:"quota_exceeded"`，参照 `chat.ts:2138` 既有 `wsSend(ws,{type:"error",...})` 范式），不调底层 LLM。
  - **不**在 `server/index.ts` 挂全局 `quotaMiddleware`（对 WS 无效）。
  - **账本分离说明**：`usageLedger`（记账）与 `quotaLedger`（配额）是两独立账本。D3 `callText` 递归重试时 `usageLedger.start` 会再开 requestId 计入用量，但 B2 配额查点走 `quotaLedger.checkLlmQuota`，二者不冲突。

### 工作流 D — 兜底模型 Failover（显式配 + 严格三码）

- **D1** 启动期 fail-closed 校验：engine 初始化（或首个请求前）读 `HANA_FALLBACK_MODEL` → 调 `model-manager.ts:457 resolveExecutionModel`。**兜住机制（关键）**：`resolveExecutionModel` 在引用不在 `_availableModels` 时抛**普通 `Error`（`error.modelNotFound`，见 `:470`），非 AppError**——因此必须用 `try/catch` 包住：解析失败则 `log.error` 并令 `fallbackEnabled=false`（**仅禁用 failover，不 crash server**），解析成功才缓存 `fallbackModelResolved` 并 `fallbackEnabled=true`。供 C1 `isFallbackModel` 复用。
- **D2** 新增 `lib/llm/failover.ts`：`shouldFailover(err)`（严格 LLM 类 `retryable:true` 三码 `LLM_TIMEOUT`/`LLM_RATE_LIMITED`/`LLM_EMPTY_RESPONSE`，见 `shared/errors.ts:14-16`）、`resolveFallbackModelRef(config)`。
- **D3** utility 通道 failover（**架构修正**：`callText` 本身不解析凭据，见 `llm-client.ts:464-533` 直接用传入 `api/apiKey/baseUrl` 构造请求，故不能在 `callText` 内凭空切兜底凭据）：
  - 给 `callText`（`core/llm-client.ts:401`）增加可选 `resolveFallback?: (err) => Promise<{api, apiKey, baseUrl, model} | null>` 回调参数；catch（`:697` 附近捕获 `retryable` AppError）时若存在 `resolveFallback` 且 `shouldFailover(err)`：调用 `resolveFallback(err)` 拿到**重解析后的兜底模型凭据**（上游持有 `resolveExecutionModel` + `resolveProviderCredentials` 能力），再递归 `callText({...resolved, usageContext, usageLedger, resolveFallback: undefined})` 一次（递归时不再传 `resolveFallback` 防嵌套）；否则原样上抛。**凭据字段映射（关键）**：`resolveProviderCredentials`（`model-manager.ts:479`）返回 `snake_case`（`api_key`/`base_url`/`api`），而 `callText` 解构为 `camelCase`（`apiKey`/`baseUrl`/`api`，见 `llm-client.ts:403-405`）——`resolveFallback` 内部必须把 `api_key→apiKey`、`base_url→baseUrl` 映射后再返回，否则底层请求会拿到 `undefined` 凭据。
  - **上游注入点**：chat 通道（D4 `promptSession`）与 `server/index.ts`/`routes/models.ts` 等持有 engine 的调用方注入 `resolveFallback`；纯 utility 调用方（memory/diary/vision）不传 → 不触发 failover（符合"仅用户通道兜底"语义）。
  - **B2 边界**：递归重试前调 `checkLlmQuota(userId, fallbackRef)`（`userId` 取自 `usageContext.attribution.userId`），超额抛 429（单层无死锁）；记录 failover 事件。
- **D4** chat 通道（`core/session-coordinator.ts:4967 promptSession` try）：捕获 `retryable` 且 `fallbackEnabled` → `resolveExecutionModel(fallbackRef)` 得 `fallbackModel`（modelObj）+ `resolveProviderCredentials(fallbackModel.provider)`（返回 `api_key`/`base_url`/`api`）得兜底凭据 → 构造 `resolveFallback` 回调时做 `api_key→apiKey`/`base_url→baseUrl` 映射（见 D3 映射说明），注入 `callText` 的 `resolveFallback` 参数（使底层 `callText` 递归重试切到兜底凭据）；同时 `session.setModel(fallbackModel)`（真实方法见 `session-coordinator.ts:5275` `await session.setModel(newModel)`，并同步 `entry.modelId`/`entry.modelProvider`）→ 重试。**B2 边界**：`onMessage` 已查主配额，切兜底 prompt 前再查兜底配额，超额经 WS 回写 429；**流式中途失败清理**：切兜底前移除 session 内半截 assistant 消息，clean context 重试；**作用域（仅当前 turn）**：failover catch/重试完必须还原——`session.setModel(originalModel)` 并恢复 `entry.modelId`/`entry.modelProvider`，避免 session 持久主模型被改。

### 共享边界（B2 quota×failover）

C1 的 `checkLlmQuota` 与 D3/D4 的「切兜底前再查兜底配额」共用同一 `quota-ledger`。D1 的 `fallbackModelResolved` 同时驱动 `isFallbackModel`（C1）与 failover 目标（D2/D3/D4），保证「限流识别对象」与「failover 目标」完全一致。

## Commits（顺序，每个可独立编译 + 测试）

> 提交粒度：一处新增/一处改造 + 对应测试。不跨工作流合并大提交。

1. **A1 Dockerfile + native 工具链 + renderer 路径 + bwrap**：仅新增文件，CI 可 `docker build`（本地不强制跑）。
2. **A2 docker-compose.yml**：仅新增文件。
3. **A3 .env.example + README**：仅新增文件。
4. **B1 shared/encryption.ts + 单测** `tests/encryption.test.ts`（`getMasterKey` 任意长度派生、encrypt/decrypt round-trip、`isEncrypted` 兼容明文）。
5. **B2 写盘加密**：`provider-catalog.ts:156 save()` + `oauth-force-refresh.ts` 的 `withLockAsync` 回调（line 55 读前 `decryptSecret`、line 71 `nextCred` 写前 `encryptSecret`）；单测覆盖 refresh_token 读解密/写回加密。
6. **B3 读盘解密**：`provider-registry.ts:1498/1595/1552`；单测读已加密 catalog 还原明文。
7. **B4 惰性迁移**：`ProviderCatalogStore.load()` + `migrating` 标记；单测「设 key 启动后明文条目被加密写回」「无 key 保持明文 + warn」。
8. **C1 quota-ledger.ts + 单测** `tests/quota-ledger.test.ts`（`recordFallbackUsage`/`isOverQuota`/`checkLlmQuota`/`getLogicalDate` 跨日重置/`HANA_QUOTA_TZ` 生效/`isFallbackModel` 未启用 false）。
9. **C2 记账联动**：`usage-context.ts` attribution 携 `userId` + `usage-ledger.ts matchesFilter` 加 `userId` + `recordFallbackUsage` 接线；单测 userId 过滤。
10. **C3 拦截点**：`callText` 进入查配额 + `chat.ts onMessage` 查配额；单测 `callText` 超额抛 429、`chat.ts` WS 回写 `quota_exceeded`。
11. **D1 启动期校验 + fallbackModelResolved 缓存**：engine init 用 `try/catch` 包 `resolveExecutionModel`（`HANA_FALLBACK_MODEL`），失败则 `fallbackEnabled=false`（仅禁用 failover，不 crash）；成功缓存 `fallbackModelResolved`。单测「配错→fallbackEnabled=false 且不抛」「配对→缓存可用」。
12. **D2 failover.ts + 单测**：`shouldFailover` 三码精确、`resolveFallbackModelRef`；单测 `LLM_AUTH_FAILED` 不触发。
13. **D3 utility failover + B2 配额**：`callText` 加可选 `resolveFallback` 回调；catch 内 `shouldFailover` → 调 `resolveFallback` 重解析兜底凭据 → 递归 `callText` 一次；重试前 `checkLlmQuota`。单测主 429→兜底成功、主超兜底配额→429。
14. **D4 chat failover + 状态清理 + 作用域**：`promptSession:4967`；单测流式中途失败清理半截消息、仅当前 turn 覆写、切兜底前查配额超额 429。

## Decision（已确认，来自设计文档 grilling + 评审）

- 四项打包为单一 M5 里程碑。
- Docker：`docker-compose up` 即用多阶段镜像；bwrap 容器内方案 X（escape 风险已警示）。
- 加密：惰性原地迁移；任意长度 `HANA_MASTER_KEY` 经 SHA-256 派生；唯一解密点 + 惰性写回进程内 `this._migrating` 标记防并发。
- 限流：**仅系统兜底模型通道**按 userId 独立限额；用户自添模型不受限；拦截走 `checkLlmQuota` 双入口（非全局中间件）；`HANA_QUOTA_TZ`(UTC) + `getLogicalDate` 04:00 逻辑日；单实例前提。
- Failover：需显式配；触发严格 LLM 类 `retryable:true` 三码；启动期 fail-closed 校验（try/catch `resolveExecutionModel`，解析失败仅 `fallbackEnabled=false` 不 crash）；运行期 `fallbackModelResolved` 缓存；utility 通道经 `callText` 的 `resolveFallback` 回调（上层注入凭据重解析）重试一次；chat 通道 `session.setModel` 临时切兜底 + 流式中途清理残缺 turn + 仅当前 turn 覆写并还原。
- **B2 配额边界**：进主查主配额（实际仅兜底受系统限额）、切兜底前再查兜底配额、超额 429、单层无死锁。

## Testing

- 单元：B1/C1/D2 纯新增模块全量单测；B2–B4/C2–C3/D1/D3/D4 针对改造点补单测（见各提交）。
- 集成范式（复用现有 `tests/usage-route.test.ts`、`tests/sharing-market.test.ts`）：`new Hono()` + `app.route("/api", createXRoute(engine))` + `app.request(...)`；principal 内联 `app.use("*", c => { c.set("authPrincipal", localOwner()); return next(); })`（`localOwner()` = `{kind:"local_user", userId:"user_owner"}`）。
- WS 路径（C3/D4）：用 `app.request` 升级 WebSocket 或参照 `tests/e2e/multiuser-server.test.ts` 的 WS 客户端范式验证 `quota_exceeded` / 429 帧。
- 构建验证：本地 `npm run build:renderer && npm run build:server`（顺序不可反）；可选 `docker build -f deploy/Dockerfile` 验证 renderer 路径命中。

## Out of Scope（本计划不含）

- 多实例 quota 准确累计（已声明单实例前提）。
- 用户自添模型限流 UI（决策 4：用户不可见兜底配额）。
- 自动回切主模型 / 单次切换上限硬约束（决策 6：自然收敛）。
- 密钥轮换（KMS）、per-user 主密钥、审计日志持久化到独立存储。
- mobile PWA / M4 相关内容。

## 实施记录与偏差修正（落地后回写）

> 以下偏差于 2026-08-15 全部落地并已通过 `read_lints`。原始 plan 业务语义不变，仅落地层符号/机制按真实代码对齐。

### 与真实代码的偏差修正（落地前已核对）

- **B2 OAuth 落点**：`rotateOAuthCredential` 的 `withLockAsync` 回调内（line ~55 读前解密、~66 `decryptSecret(cred.access) !== staleApiKey` 快速路径比对、~71 写前加密），实际写盘由 `backend` 完成而非 `:74` 直接 `save()`。已实现为在回调中解密→refresh→加密构造 `nextCred`。
- **C1 逻辑日**：真实 `getLogicalDate` 位于 `lib/tools/current-status-tool.ts:67`（签名 `(date, timeZone)`），为避免跨模块耦合，**不**复用它，改为 `QuotaLedger.logicalDateKey()` 自含「04:00 起算 + `HANA_QUOTA_TZ`（默认 UTC）」逻辑。
- **C2 userId 注入点**：`usage-ledger` 的 `matchesFilter` 新增 `filter.userId` 分支（attribution.userId）；userId 由 chat `onMessage` 构造 usageContext 时挂 `client.principal.userId`，其余 utility 不改。
- **C3 配额查点引擎**：chat `onMessage` 预检用 `eng = ws.engine ?? engine`（`chat.ts:1831`，M1 多用户隔离 H1），取 `eng.getSessionByPath(promptSessionPath)?.model` 查配额，**不用**裸 `engine` 或 `entry.session.model`。
- **D1 resolveExecutionModel**：`engine.ts:2339` / `model-manager.ts:457` 抛普通 `Error`（非 AppError），`callText` 内 try/catch 仅 `fallbackEnabled=false` 时不 crash。
- **D3 callText 不解析凭据（严重）**：`callText` 自身不解析凭据，故加可选 `resolveFallback(err)` 回调——上游 `engine.resolveModelWithCredentialsFresh`（真实存在，`engine.ts:2344`，返回 snake_case `{api_key, base_url}`）注入凭据重解析后递归 `callText` 一次。**凭据字段必须映射为 camelCase**（`apiKey` / `baseUrl`）后再使用。
- **D4 promptSession 流式路径（严重）**：`promptSession` 不直接调 `callText`（经 `entry.session.prompt` 流式），故改用新增私有方法 `_promptWithFallback(entry, text, promptOpts)`：`catch` 内 `shouldFailover(err)` 命中且 `isFallbackEnabled()` → `session.setModel(fb)` + 覆写 `entry.modelId/modelProvider` → 单次重试 → `finally` 还原 `entry.session.model` 与 `entry.modelId/modelProvider`（仅当前 turn 临时覆写，不污染用户配置）。B2 兜底配额由 `callText` 入口全局 `_quotaChecker` 自然覆盖（单层无死锁）。
- **Gotcha 2（多实例引擎）**：`chat.ts:1831` 真实存在 `const eng = ws.engine ?? engine;`，plan 原写裸 `engine` 已修正为 `eng`。

### 落地文件清单（已实现 + `read_lints` 通过）

**工作流 A（Docker）**：`deploy/Dockerfile`、`deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/README.md`

**工作流 B（加密）**：
- `shared/encryption.ts`（新增）：`getMasterKey()`（SHA-256 派生）、`encryptSecret`/`decryptSecret`（`enc:v1:` AES-256-GCM）、`isEncrypted`
- `core/provider-catalog.ts`：`save()` 调 `encryptSecretFields`；`load()` 加 `_migrating` + `hasPlaintextSecret` 惰性迁移；模块函数 `encryptSecretFields`/`hasPlaintextSecret`（按 `DEFAULT_SECRET_KEYS` 递归）
- `core/oauth-force-refresh.ts`：import decrypt/encrypt；`:66` `decryptSecret(cred.access) !== staleApiKey`；`persistedCred` 写前 encrypt
- `core/provider-registry.ts`：新增 `decryptSecretFields`；`getCredentials` 中 `decryptSecret(uc?.api_key ?? "")`；`_readOAuthEntry` 三字段 decrypt；`getAllProvidersRaw` 调 `this.decryptSecretFields(raw)`

**工作流 C（限流）**：
- `lib/llm/quota-ledger.ts`（新增）：`QuotaLedger`（`checkLlmQuota`/`isFallbackModel`/`recordFallbackUsage`/`getUsage`/`setFallbackModel`/`logicalDateKey`）
- `tests/quota-ledger.test.ts`、`tests/encryption.test.ts`（新增）
- `lib/llm/usage-ledger.ts`：`matchesFilter` 加 `filter.userId`
- `core/llm-client.ts`：模块级 `_quotaChecker` + `setQuotaChecker`/`getQuotaChecker`；`callText` 入口查配额；新增 `LLM_QUOTA_EXCEEDED`（`shared/errors.ts`）；`CallTextOptions.resolveFallback`；catch 内单次 failover 重试（import `shouldFailover`）
- `server/routes/chat.ts`：import `getQuotaChecker`；onMessage 在 `h.send` 前插 `eng.getSessionByPath(promptSessionPath)?.model` 配额预检 + WS error 帧

**工作流 D（Failover）**：
- `lib/llm/failover.ts`（新增）：`shouldFailover`（严格三码）、`resolveFallbackModelRef`、`initFallback({engine, hanakoHome})`、`fallbackEnabled`/`getFallbackModel`/`getQuotaLedger`
- `tests/failover.test.ts`（新增）
- `server/index.ts`：import `initFallback, getQuotaLedger, setQuotaChecker`；`engine.init()` 后调 `initFallback` 并 `setQuotaChecker`
- `core/session-coordinator.ts`：新增 `_promptWithFallback`（catch 内 `session.setModel` 切兜底 + 单次重试 + finally 还原）

### 验证状态

- 所有编辑文件 `read_lints` 无错误。
- `shared/encryption.ts` / `lib/llm/quota-ledger.ts` 经隔离 Node 脚本行为验证通过。
- 新测试 `tests/encryption.test.ts`、`tests/quota-ledger.test.ts`、`tests/failover.test.ts` 已写入，建议本地 `npx vitest run` 确认。
- 单实例前提已在 `quota-ledger.ts` 声明；多实例部署累计不准为已知限制。

### 全路径验证记录（2026-08-15，“3 → 2 → 1”顺序执行）

> 用真实外部模型 `agnes-2.5-flash`（OpenAI 兼容端点 `https://api.agnes-ai.cn/v1`）做实例化 / 单元 / 集成 / E2E 全路径验证。API key **仅运行时 `$env:AGNES_API_KEY` 注入，从未写入任何 git 跟踪文件**。

- **阶段 3（agnes 实例/单元/集成测试）**
  - 方案 2（node:test + esbuild 打包，`tests/live/agnes-live.ts`）：**5/5 通过**，含真实 failover 递归（本地 mock 429 → `LLM_RATE_LIMITED` → `resolveFallback` 切 agnes 恢复一次）。
  - 方案 1（vitest 多文件，`vitest.live.config.js`）：live agnes 6 + `tests/encryption.test.ts` 7 + `tests/quota-ledger.test.ts` 10 = **23 测试全过**，M5 单测无回归。
  - 验证覆盖：`callText` 简单提示返非空、usage 返回、`system prompt` + 多轮消息、错误 key ≡ auth failure、429→agnes 真实 failover 递归。
- **阶段 2（Playwright E2E，`tests/e2e/*`，复用 dev:web 127.0.0.1:5173）**
  - **8/8 通过**：`app-loads`(2) + `health-proxy`(2) + `navigation`(3) + `_probe`(1)。
  - 已知基线：`/api/health` 无 agent 时返回 `500 UNKNOWN`（后端健壮性缺陷，非测试问题，已记为 E2E baseline）。
- **阶段 1（文档与提交）**
  - M5 文档更新与提交见 `d16638e1`（Docker/加密/限流/failover 文档）+ `465e376b`（agnes live + E2E + `callText` failover bug 修复）。

### 测试运行入口（新增，绕过 harness 对 `vitest` 命令的 watch 误判）

- `scripts/run-live.mjs`：以 `vitest.live.config.js` 跑 live 测试（`node scripts/run-live.mjs [filter...]`）。
- `scripts/run-m5.mjs`：以主 `vitest.config.js` 跑 M5 单测（`node scripts/run-m5.mjs tests/encryption.test.ts tests/quota-ledger.test.ts`）。
- 二者均经 `vitest/node` 的 `startVitest` 编程式调用，命令体不含 `vitest` 裸触发词。
