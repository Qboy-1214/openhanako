# M1 Spec: 多用户隔离接管（后端收尾）

> 来源：docs/REARCHITECTURE.md（ADR-1~17）+ M0 实施复盘 + brainstorming 收敛
> 前置：M0 多用户 Web 骨架（docs/superpowers/specs/m0-multiuser-web-skeleton.md）
> 部署：仍仅本地 dev 模式（`npm run dev:web`）
> 隔离模型：继承 M0 GRILL Q11-A —— 业务数据按用户隔离 + 鉴权/协调 system 级共享

## 0. M0 现状与 M1 动机

M0 验证了"机制存在"但未让隔离落到运行时：
- `EngineLifecycle` 引用计数 + WS 静默计时机制已建（单测通过）
- `register.ts` 双根写（账号/密码落 `system/`，业务 home 建 `users/<userId>/`）
- `assertWithinUserRoot` path-guard 函数已建，但**未接运行时边界**
- `userEngineMiddleware` / `bindEngineToWs` 接缝已建，但**路由仍走全局兜底 `ctx.engine`**
- `engine.ts` 支持双根构造（`systemRoot` 字段），但据 codesearch 该字段当前为死字段（0 读取）；engine 内各 manager 持久化根均为 `hanakoHome`（业务域），系统级共享数据压根不经 engine 落盘（见 §2）

M1 让隔离真正落到**物理落盘 + 运行时边界 + 账号生命周期**。

## 1. 范围与目标

### 目标（4 件）
1. **双根分库真落地**：据 codesearch，engine 内无系统级 manager（系统级数据由 server 层经 `systemStoreDir` 落 `<baseDir>/system/`），每个用户 engine 的 `hanakoHome = users/<userId>`、`systemRoot = <baseDir>/system` 已天然构成双根；M1 仅需固化"全局兜底引擎 + 每用户引擎共用同一 `systemRoot`"的透传不变量，不注入 rootOverride。
2. **高敏感路由按用户引擎接管**：`open-root.ts` 中 chat/sessions/agents/upload/fs/preferences 等高敏感路由，经 `getEngine(c)`（F1）取当前用户引擎，不再走全局兜底引擎。
3. **path-guard 接运行时边界**：`assertWithinUserRoot` 在 upload/fs/desk/character-card 等**路由 handler 接收 caller 绝对路径的边界**直接调用（不建 exemption 基础设施，GRILL 拷问 4/D1）。
4. **账号注销/删除（ADR-12）**：软删（标记 disabled + 停引擎）+ 硬删（清 `users/<userId>/` + 移除 `users.json`/`local-user-auth.json` 条目）。

### 隔离模型（继承 M0，不变）
- **system 层（共享）**：`users.json`、`local-user-auth.json`、`web-sessions.json`、`security/grants.json`、`server-node.json`、`data-epoch*`、`provider-catalog.json`
- **user 层（隔离）**：`users/<userId>/` 下业务数据 `agents/ sessions/ memory/ channels/ plugins/ skills/ user/preferences.json` 等

### 纳入（M1）
- 引擎内部双根分库（方案 A：引擎内部分类路由）
- 高敏感路由接管（仅高敏感类，非全量）
- path-guard 接运行时边界（路由 handler 直接调 guard，GRILL Q10/D1）
- 账号软删/硬删 + 注销路由
- E2E 集成测试（真起 dev:web server）

### 排除（M1 不做）
- 前端路由化（react-router / 登录页）→ **M2**
- 分享市场（ADR-16）、沙箱运行时（ADR-15）→ 后续里程碑
- Web Push / 后台推送 → 后续
- OIDC 厂商接入（仅 `AuthProvider` 接口占位）→ 后续
- Docker / 生产部署 → 后续

## 2. 双根分库落地机制（方案 A）

### 核心改造点（GRILL + 代码核查修正：engine 内无系统级 manager）
> **代码核查结论（M1 plan Task 0）**：grep `core/engine.ts` 确认 `LocalUserAccount` / `WebSession` / `GrantStore` / `ServerIdentity` / `DataEpoch` **均不存在于 engine 内**。engine 内 51+ 处 `hanakoHome` 全部是业务级（AgentManager / ModelManager / PreferencesManager / SessionFileRegistry / FileHistoryService / CheckpointStore / UsageLedger / ConfigCoordinator 等）。`systemRoot` 字段在 engine 构造期仅声明（L333 `declare systemRoot`）+ 赋值（L352 `this.systemRoot = systemRoot || hanakoHome`），**0 处读取**——因为它管理的都是用户业务数据，本就无需走 system 根。
>
> **因此"双根分库真落地"在 engine 层已基本自然成立**：每个用户 engine 由 `EngineLifecycle.defaultFactory` 以 `hanakoHome = users/<userId>`、`systemRoot = <baseDir>/system` 构造（lifecycle L55-69）。**系统级共享数据从不在 engine 内落盘**，而是在 server 层经 `systemStoreDir(baseDir)` 落 `<baseDir>/system/`（register.ts / server-identity / data-epoch）。**M1 在 engine 层无需逐 manager 注入 rootOverride**。
>
> 原 GRILL 拷问 1 假设的"让 systemRoot 被系统级 manager 消费"在 engine 内 **N/A**——这是 spec 初稿基于错误假设（以为 auth/web-sessions 是 engine manager）。本段已据实修正。M1 engine 层唯一动作：让全局兜底 engine（server/index.ts L437）也传 `systemRoot`，保证 H1 不变量（未来若有 manager 走 systemRoot，与用户引擎一致）。

### engine 层 M1 动作（已据代码核查收敛）
> **已 codesearch 确认（与 §2 顶部结论一致）**：`core/engine.ts` 中 `LocalUserAccount` / `WebSession` / `GrantStore` / `ServerIdentity` / `DataEpoch` / `security/grants` **grep 全 0 命中**——这些系统级数据根本不是 engine 的 manager，而是 server 层经 `systemStoreDir(baseDir)` 落盘。**因此 engine 内不存在"系统级 manager 清单"，也不存在 `ENGINE_SYSTEM_MANAGERS` 表（代码中 0 命中）。** 原 GRILL 拷问 1/2/3 初稿假设的"逐 manager 注入 rootOverride"在 engine 内 **N/A**。

engine 层 M1 唯一动作（保持 H1 不变量，非业务改造）：
1. `this.systemRoot = systemRoot || hanakoHome` 已在 L352 赋值（L333 声明），**透传即可读**，无需新字段。
2. 确保全局兜底 engine（`server/index.ts` 构造处）也传 `systemRoot`，与 `EngineLifecycle.defaultFactory` 的 `<baseDir>/system` 物理一致。
3. **不做** provider-catalog 系统共享（K1）：每个用户引擎独立配置，同步留 M2。

> 注：`SYSTEM_STORE_KINDS`（`core/multiuser/user-db.ts`）是 store 字符串集合，服务于 server 层 user-db 工厂，与 engine manager 无映射层，两条独立体系不强行统一（GRILL 拷问 2）。

### 风险与边界
- ⚠️ provider-catalog 系统共享已明确**排除出 M1**（K1），每个用户独立配置，系统级同步留 M2。

## 3. 高敏感路由接管 + path-guard 集成

### 3.1 高敏感路由接管
M0 的 `userEngineMiddleware` 机制已就绪（`use`→`releaseRef` 单次配对）。M1 把它**应用到高敏感路由**，不再走 `ctx.engine` 全局兜底。

**分类策略**（仅改高敏感，其余留 `ctx.engine`）：

| 类别 | 路由 | M1 处理 |
|---|---|---|
| **高敏感·接管** | chat / sessions / session-collab / session-projects / agents / upload / fs / preferences / skills / channels / dm / studio-workspaces | 包 `userEngineMiddleware(lifecycle)`；工厂经 F1 `getEngine(c)` 取用户引擎 |
| **系统级·留全局** | web-auth / auth / confirm / ws-auth / access / server-identity / models / config | 保持 `ctx.engine`（系统共享，不按用户）。注：M1 **不碰** provider-catalog 系统共享（K1），每个用户引擎独立 config/models 配置 |
| **只读·留全局** | media / mcp / plugins / commands / experiments / bridge / resources / usage / file-history / checkpoints / devices / providers / input-drafts / settings-snapshot / speech-recognition | 保持 `ctx.engine`（M2 再评估） |

**实现（GRILL 拷问 6 修正：路由工厂注册期捕获全局 engine，非零改）**：
> **GRILL 拷问 6 实锤**：`createChatRoute(engine, hub, ...)`（chat.ts L341）在**注册期**把 `engine` 捕获为闭包参数，内部 38+ 处 `engine.xxx()` 全用注册期全局 engine，**完全不读 `c.get('engine')`**。`open-root.ts` L92 传的就是全局 `ctx.engine`。因此"包 userEngineMiddleware 即可、路由代码零改"对 chat/sessions 类工厂**不成立**——中间件只把用户引擎塞进 context，但路由闭包仍用全局引擎，用户 A 的 chat 实际读写全局引擎数据。

- 采纳 **F1（facade 注入）**：高敏感路由工厂签名 `createXRoute(engine, ...)` 升级为 `createXRoute(getEngine: (c) => HanaEngine, ...)`；工厂闭包首行 `const engine = getEngine(c)`（或内部 `engine.xxx` 改为 `getEngine(c).xxx`）。`open-root.ts` 对高敏感路由传 `getEngine = (c) => c.get('engine') ?? ctx.engine`。
- 改动收敛在工厂入口 + 闭包首行解引用，**业务 handler 逻辑零变**。单用户退化时 `getEngine(c)` 恒返回全局 engine，行为不变。
- `userEngineMiddleware` 仍负责请求期 `c.set('engine', handle.engine)` + `finally` 单 release（机制不变）。
- `ctx.engine` 保留为 fallback，仅给未接管路由（系统/只读类）用。
- 关键约束（GRILL Q4）：WS 通道（chat WS）也必须经 `bindEngineToWs(lifecycle)` 走同一 lifecycle，避免"HTTP 结束就 dispose"错配。
- **GRILL 拷问 8 不变量（H1）**：所有 engine 实例（全局兜底 + 每用户）必须共用**同一 `systemRoot` 物理目录**（M0 单 baseDir 已成立）。在 `EngineLifecycle.defaultFactory` 与全局引擎构造时传同一 `systemRoot`，并加单测断言"所有 handle 的 systemRoot 相等"，否则用户引擎写的 auth 全局引擎读不到。

### 3.2 path-guard 接运行时边界（GRILL 修正：exemption 非代码实体）
> **GRILL 拷问 4 结论**：store-registry 中 `exemption`/`PersistenceExemption` **0 处**——GRILL Q10 的 exemption 是设计意图，不是代码实体。M1 不建 exemption 基础设施，改为在路由 handler 边界直接调 guard。

M0 的 `assertWithinUserRoot(userId, p)` 已建但未接运行时。M1 按 GRILL Q10 边界，在**路由 handler 接收 caller-selected 绝对路径的入口**直接调用：

| 入口 | 文件 | M1 动作 |
|---|---|---|
| 上传目标目录 | `server/routes/upload.ts` | 接收 caller 上传绝对路径前 `assertWithinUserRoot(userId, targetDir)` |
| desk workspace 根 | `server/routes/desk.ts` | workspace 根路径校验归当前用户 |
| desktop 外部文本文件 / caller 选中输出 | desk / file-io | caller 选中绝对路径校验 |
| character-card 复制目标 | `lib/character-cards/service.ts` | 复制目标路径校验 |
| fs / mount-aware / file-ref | 对应 fs 入口 | fs 路由接收绝对路径前校验 |

实现原则：
- guard 只在**接收 caller-selected 绝对路径的 API 边界**调用，不包引擎内部受管路径。
- `assertWithinUserRoot(userId, target, baseDir?)`（`core/multiuser/paths.ts` L45）越界抛 `PathGuardError`（同文件 L33）→ 路由层 try/catch 转 403。调用处据需传 `baseDir`（用户 home 根，缺省时函数内部取默认）以正确解析用户根。
- `userId` 从 **`c.get('principal').userId`** 取（GRILL 拷问 5 结论：engine 实例不携带 userId，HanaEngine 无 userId 字段；userId 是 web 请求上下文概念，从 principal 取，不反查 engine）。

### 3.3 风险
- ⚠️ 高敏感路由经 `getEngine(c)` 取用户引擎，系统/只读路由用注册期全局 `ctx.engine` → 两套并存（R9）。不变量：所有引擎共用同一 `systemRoot`（H1），单测固化一致性。
- ⚠️ **R6（idle 回收条件，实锤）**：`engine-lifecycle.ts` 的 `sweep()` 已有 `setInterval` ticker（L52），但 dispose 条件为 `refCount > 0 && idle`（L125）—— **refCount===0 的引擎永不 dispose**，空闲回收失效。采纳 **G1**：修正 `sweep` 条件为"state===ready 且 idle 超时即回收"（移除 `refCount>0` 限制）；WS 挂着时由 `keepAlive(userId)`（L108）续命防止误回收，进程退出 `drainAll`（L140）。单测覆盖"WS 挂着、HTTP 结束"场景。
- ⚠️ WS chat 与 HTTP chat 共享同一 lifecycle，引用计数错配风险（R7）→ 单测覆盖"WS 挂着、HTTP 结束"场景。

## 4. 账号注销/删除（ADR-12）+ E2E 验收

### 4.1 账号注销 / 删除
双根分库后用户数据集中在 `users/<userId>/`，注销与隔离闭环天然配合。

**软删（soft-delete）**：
- `system/users.json` 中该用户标记 `disabled: true` + `disabledAt`。
- 停其 EngineLifecycle handle：先 `lifecycle.releaseRef(userId)` 释放所有请求引用；若需立即清内存态，调用 `lifecycle.drainAll()`（已存在，L140，遍历 dispose 所有非 disposed handle）或新增 `lifecycle.disposeUser(userId)` 公开方法（内部复用 `disposeHandle`）。注意与 R6 一致：`refCount>0` 的 handle 不会被 `sweep` 回收，**软删前应确保所有在途请求/WS 已释放引用（releaseRef 归零）**，否则 dispose 不触发；WS 挂着时由 `bindEngineToWs` 配对 release 保证归零。
- 保留 `users/<userId>/` 目录与 `local-user-auth.json` 哈希（可恢复）。
- 路由层：disabled 用户访问任何高敏感路由 → 403 `account_disabled`。

**硬删（hard-delete）**：
- 前置：必须先软删（或硬删隐式先软删）。
- 删除 `users/<userId>/` 目录（`fs.rmSync(recursive)`）。
- 从 `system/users.json` 移除该条目；若为 `SYSTEM_ADMIN` 且是末位 admin → **拒绝硬删**（GRILL 拷问 9 / I1）。
- 从 `system/local-user-auth.json` 移除哈希。
- 清 `system/web-sessions.json` 中该用户所有 session（强制登出）。

**实现文件**：
- `server/auth/unregister.ts`（**M1 新建**）— `softDeleteUser(baseDir, userId)` / `hardDeleteUser(baseDir, userId)`；复用 `register.ts` 的 `readUsersJson`/`findUserByUsername` + 注册锁（防并发删/注册竞态）。新增 `countSystemAdmins(baseDir)` = `readUsersJson().users.filter(u => u.scopes?.includes('SYSTEM_ADMIN')).length`；硬删前若 `scopes.includes('SYSTEM_ADMIN') && countSystemAdmins(baseDir) <= 1` → 抛 `LastAdminError`（路由层转 409 `last_admin`）。
- `server/routes/web-auth.ts` — 加 `DELETE /web-auth/account`（软删）+ `DELETE /web-auth/account/hard`（硬删，需 `SYSTEM_ADMIN` 或本人 + 二次确认 scope）。
- `core/local-user-account.ts` — 加 `removeLocalAccountPasswordForUser(hanakoHome, userId)` 导出，复用现有哈希删除逻辑。

### 4.2 E2E 验收（真起 dev:web）
按决策，M1 加**真起 server 的 E2E 集成测试**（最可信）：

**测试基建（GRILL 拷问 10 修正：startServer 必须先多用户化）**：
> **GRILL 拷问 10 实锤**：`server/index.ts` 的 `startServer(root)` 内部用单个 `hanakoHome` 构造**唯一全局 engine**（L437），`mountOpenRoutes(ctx)` 的 `ctx.engine` 即此唯一引擎；`engineLifecycle`（M0 加）与全局 engine 是两套、未被接到路由。当前 `startServer` **不传 systemRoot、不接 lifecycle 到路由**，无法真起多用户 server。

- 前置（M1 显式任务 **T13**）：改造 `startServer` 使其 `CompositionRoot` 携带 `systemRoot`，并将 `engineLifecycle` 接线进 `open-root`，使高敏感路由经 `getEngine(c)` 取用户引擎、所有引擎共用同一 `systemRoot`。否则 E2E 无多用户可测。
- `tests/e2e/multiuser-server.test.ts` — 用临时目录作 `baseDir`，设 `HANA_HOME=<tmpBase>/system` 注入，真起改后的 Hono app（不走 Vite，监听随机端口）。
- 复用 M0 的 `registerUser` / `verifyLocalAccountPassword` 直接操作 `system/`。
- 用 `fetch` 打 `http://127.0.0.1:<port>/api/...`。

**E2E 用例**：
1. 注册 A、B → 断言 `system/users.json` 含 A/B，A 标 `SYSTEM_ADMIN`；`users/<A>/`、`users/<B>/` 目录存在。
2. **双根分库落盘**：A 创建 agent / session → 断言文件落在 `users/<A>/agents/`、`users/<A>/sessions/`；`system/` 下无业务数据。
3. **path-guard 越权**：B 持 A 的 upload 绝对路径调 upload → 断言 403 `PathGuardError`。
4. **引擎隔离**：A、B 同时在线 → `engineLifecycle.activeCount() >= 2`，各自 `engine.hanakoHome`（`= users/<A>` / `users/<B>`）不同。
5. **注销清目录**：硬删 A → 断言 `users/<A>/` 消失、`users.json` 无 A、`local-user-auth.json` 无 A 哈希、A 的 session 清除。
6. **注册锁回归**：并发抢首注册仅一人 admin（M0 已有单测，E2E 补真起验证）。
7. **A-dispose-B 正常**：A 引擎 `dispose()` 后 B 仍正常工作（M0 单测固化，E2E 补真起）。

### 4.3 风险
- ⚠️ E2E 真起 server 可能慢（engine.ts 转译）；用动态 `import()` + 临时 `baseDir` 隔离，类比 M0 删 `engine-dual-root.test.ts` 的教训。
- ⚠️ 硬删 admin 转移逻辑易错 → 单测覆盖"末位 admin 拒绝硬删"。
- ⚠️ Windows `fs.rmSync(recursive)` 对占用中目录可能 EBUSY → E2E 先 dispose 引擎再删。

## 5. 验收清单（DoD）

1. `npm run dev:web` 启动，注册 A → `users/<A>/` 业务 home 创建；A 创建 agent/session 落 `users/<A>/`，`system/` 下无业务数据（双根分库真落地）。
2. 注册 B（非 admin）→ 各自 `users/<B>/` 隔离；B 持 A 的绝对路径调 upload/fs → 403 `PathGuardError`。
3. A、B 同时在线，`engineLifecycle.activeCount() >= 2`，各自 `engine.hanakoHome`（`users/<A>`/`users/<B>`）不同；高敏感路由（chat/sessions/agents）经 `getEngine(c)` 取用户引擎，且所有引擎 `systemRoot` 一致（H1/R8）。
4. A 引擎 `dispose()` 后 B 仍正常（隔离不互杀）。
5. 软删 A → A 访问高敏感路由 403 `account_disabled`；硬删 A → `users/<A>/` 消失、`users.json`/`local-user-auth.json` 无 A、A session 清除。
6. 末位 `SYSTEM_ADMIN` 硬删被拒（需先转移 admin）。
7. E2E 集成测试（`tests/e2e/multiuser-server.test.ts`）全绿：双根落盘 + path-guard 越权 + 注销清目录 + 引擎隔离（含所有引擎 systemRoot 一致断言 H1）+ 注册锁回归；`startServer` 经 T13 多用户化。

## 6. 风险汇总（GRILL 烤问后修订）

| 风险 | 描述 | 缓解（GRILL 修正） |
|---|---|---|
| R5（双根分库） | `engine.ts` 中 `this.systemRoot` 是死字段（0 处读取）；~30 处 manager 用 `this.hanakoHome` | 经 codesearch 确认 engine 内无系统级 manager（系统级数据走 server 层 `systemStoreDir`）；M1 只需固化"全局兜底引擎 + 每用户引擎共用同一 `systemRoot`"透传不变量（A1/B1/K1）：全局引擎构造处显式传 `systemRoot`，单测断言双根物理分落 |
| R6（idle 回收） | `sweep()` 已有 `setInterval` ticker（engine-lifecycle.ts L52），但 dispose 条件为 `refCount > 0 && idle`（L125）——**refCount===0 的引擎永不 dispose**，空闲回收失效 | G1：修正 `sweep` 条件为"state===ready 且 idle 超时即回收"（移除 `refCount>0` 限制），使归零引擎也能被回收；WS 挂着时由 `keepAlive(userId)`（L108，HTTP 请求/WS 消息往来续命）防止误回收，而非依赖 `refCount>0`；进程退出 `drainAll`（L140） |
| R7（WS/HTTP 引用计数） | WS 挂着 HTTP 结束误 dispose | 统一经 `bindEngineToWs` + `userEngineMiddleware` 走同一 lifecycle；单测覆盖"WS 挂着 HTTP 结束" |
| R8（两套引擎并存） | 接管路由用 `getEngine(c)` 用户引擎、系统路由用全局 | H1：所有引擎共用同一 `systemRoot`，加一致性单测；E2E 验证不串 |
| R9（硬删竞态/admin） | 并发删/注册、末位 admin | 复用注册锁；`countSystemAdmins` + 末位 admin 拒绝硬删（409，I1）单测 |
| R10（E2E 慢/占用） | engine.ts 转译慢、Windows EBUSY | 动态 import + 临时 baseDir；先 dispose 再删 |
| R11（路由闭包捕获） | 高敏感路由工厂注册期捕获全局 engine，中间件零改无效 | F1：工厂 `engine` 参数升级为 `getEngine(c)` 回调，闭包首行解引用；业务逻辑零变 |
| R12（startServer 单引擎） | `startServer` 只建唯一全局 engine、不接 lifecycle/systemRoot，无法真起多用户 | J1/T13：改造 `startServer` 接 `systemRoot` + 将 `engineLifecycle` 接线进 open-root |
| R13（provider 共享误判） | 误以为 provider-catalog 可"最小补丁"共享 | K1：M1 明确排除，每用户独立配置，系统同步留 M2 |

## 7. 任务拆解（供 writing-plans 细化，GRILL 修正后）

- T0：审计 engine.ts 全部 manager 构造，确认 systemRoot 当前为死字段（仅 L333 声明 + L352 赋值，0 读取）、engine 内无系统级 manager（codesearch 0 命中 `LocalUserAccount`/`WebSession`/`GrantStore`/`ServerIdentity`/`DataEpoch`/`security/grants）；系统级数据走 server 层 `systemStoreDir`（A1 前置，已据代码核查收敛 —— 见 §2）
- T1：引擎层双根"透传"固化 —— 不新建常量表/不注入 rootOverride；仅断言 `systemRoot` 在 `EngineLifecycle.defaultFactory` 全局兜底引擎与用户引擎间物理一致（`hanakoHome` 仍是 `users/<userId>`，`systemRoot` 仍是 `<baseDir>/system`），单测固化分落（A1/B1/K1）
- T2：全局兜底引擎（`server/index.ts` 构造处）显式传 `systemRoot`，与 lifecycle 默认工厂 `<baseDir>/system` 对齐（非业务改造，保持 H1 不变量）
- T3：provider-catalog 系统共享**明确排除**（K1），留 M2
- T4：（并入 T1）双根分库单测（临时 baseDir，断言 `<baseDir>/system/` 与 `users/<A>/` 分落，且 system 由 server 层 user-db 落盘而非 engine manager）
- T5：**F1 改造**：高敏感路由工厂签名 `engine` → `getEngine(c)`；`open-root.ts` 传 `getEngine = (c) => c.get('engine') ?? ctx.engine`（R11）
- T6：chat WS 经 `bindEngineToWs` 走 lifecycle（G1，R6）；修正 `EngineLifecycle.sweep()` 条件使 refCount===0 的空闲引擎可被回收（见 R6）
- T7：path-guard 在 upload/fs/desk/character-card handler 边界直接调 `assertWithinUserRoot(principal.userId, path)`（D1/E1，非 exemption 机制）
- T8：`unregister.ts` 软删/硬删 + `countSystemAdmins` + 末位 admin 拒绝（I1）+ 注册锁复用
- T9：`web-auth.ts` 加 `DELETE /web-auth/account` / `/hard`（硬删 409 last_admin）
- T10：`local-user-account.ts` 加 `removeLocalAccountPasswordForUser`
- T11：E2E `tests/e2e/multiuser-server.test.ts`（7 用例，含双引擎 systemRoot 一致性断言 H1）
- T12：文档更新（open-root.ts M0 范围声明改为 M1 已接管）+ spec 自审回填
- **T13（GRILL 拷问 10，J1）**：改造 `server/index.ts` 的 `startServer` 使其 `CompositionRoot` 携带 `systemRoot`（非独立参数），并将 M0 已建的 `engineLifecycle` 接线进 `open-root`（替换/并存全局 engine 兜底），使高敏感路由经 `getEngine(c)` 取用户引擎、所有引擎共用同一 `systemRoot`。E2E 真起多用户 server 的前置条件。
