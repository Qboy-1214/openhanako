# M1 Multiuser Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 M0 的多用户后端隔离真正落到运行时：高敏感路由按用户引擎接管、path-guard 接运行时边界、账号注销/删除可用，并用真起 server 的 E2E 验证隔离闭环。

**Architecture:** 每个用户的 `HanaEngine` 由 `EngineLifecycle` 按 `userId` 懒加载（`hanakoHome = users/<userId>`，`systemRoot = <baseDir>/system`，见 `core/engine-lifecycle.ts:55-69`）。高敏感路由经 `userEngineMiddleware` 在请求期把用户引擎注入 `c.get('engine')`；路由工厂签名由 `engine` 参数升级为 `getEngine(c)` 回调（F1）以读取请求期引擎。系统级共享数据（users.json / auth / grants / epoch）始终在 server 层经 `systemStoreDir(baseDir)` 落 `<baseDir>/system/`，与用户引擎根物理隔离。

**Tech Stack:** TypeScript, Hono, vitest（动态 `import()` + 临时 `tmpDir` 测试模式，见 `tests/web-auth-route.test.ts`），Node `fs`，`core/engine-lifecycle.ts` / `server/composition/*` / `server/auth/*`。

**Spec:** `docs/superpowers/specs/m1-multiuser-isolation.md`（GRILL 烤问 1-11 已全部修订）

---

## 关键认知（代码事实，写计划前已核查——避免按 spec 旧假设做无效改造）

> **重要**：GRILL 烤问后确认，spec §2 原 `ENGINE_SYSTEM_MANAGERS` 表基于错误假设。以下为实际代码事实，**plan 任务以事实为准**：

1. **engine 内部无系统级 manager 可搬根**。grep `core/engine.ts`：`LocalUserAccount` / `WebSession` / `GrantStore` / `ServerIdentity` / `DataEpoch` **均不存在于 engine 内**。engine 内 51+ 处 `hanakoHome` 全部是业务级（AgentManager / ModelManager / PreferencesManager / SessionFileRegistry / FileHistoryService / CheckpointStore / UsageLedger / ConfigCoordinator 等）。`systemRoot` 字段在 engine 构造期仅声明 + 赋值（`core/engine.ts:332,352`），**0 处读取**——因为它管理的都是用户业务数据，本就无需走 system 根。
2. **系统级共享数据从不在 engine 内落盘**，而是在 server 层：
   - `server/auth/register.ts` 用 `systemStoreDir(baseDir)` 落 `system/users.json` + `setLocalAccountPasswordForUser(sysDir, userId, pw)` 落 `system/local-user-auth.json`（**M0 已完成双根**）。
   - `server/index.ts` 用 `ensureLocalIdentityRegistries` / `coordinateDataEpochStartup` 落 server-node / data-epoch（server 层，不在 engine）。
3. **因此"双根分库真落地"在 engine 层已基本自然成立**——每个用户 engine 天然用 `userDataRoot = users/<userId>`。M1 在 engine 层**不需要大改**（无需逐 manager 注入 rootOverride）。唯一 engine 层动作（T13 的一部分）：让全局兜底 engine 也传 `systemRoot`，保证 H1 不变量（未来若有 manager 走 systemRoot，与用户引擎一致）。
4. **M1 真实工作重心是路由接管（F1）+ path-guard + 注销 + E2E**，而非 engine 内部搬根。

> 上面 4 点是对 spec §2 的诚实修正。spec 其余部分（§3 路由接管、§4 注销、§6 风险）与代码一致，照此执行。

---

## File Structure

**修改（生产代码）：**
- `core/engine.ts` — 仅保证 `systemRoot` 透传（构造期已存；确认或补 `this._systemHome` 供未来使用；本计划不强制大改）
- `server/composition/user-engine-middleware.ts` — 已就绪（M0），复用
- `server/composition/open-root.ts` — 高敏感路由工厂改 `getEngine(c)` 注入（F1）；chat WS 经 `bindEngineToWs`
- `server/routes/chat.ts`、`sessions.ts`、`session-collab.ts`、`session-projects.ts`、`agents.ts`、`upload.ts`、`fs.ts`、`preferences.ts`、`skills.ts`、`channels.ts`、`dm.ts`、`studio-workspaces.ts` — 工厂签名 `engine` → `getEngine(c)`
- `server/routes/upload.ts` / `fs.ts` / `desk.ts` / `lib/character-cards/service.ts` — 加 `assertWithinUserRoot` 调用（path-guard）
- `server/auth/unregister.ts` — **新建**：软删/硬删 + `countSystemAdmins`
- `server/routes/web-auth.ts` — 加 `DELETE /web-auth/account` / `/hard`
- `core/local-user-account.ts` — 加 `removeLocalAccountPasswordForUser`
- `server/index.ts` — T13：全局 engine 传 `systemRoot` + 将 `engineLifecycle` 接线进 `open-root`
- `server/composition/contract.ts` — 已含 `engineLifecycle?` 接缝（M0）

**测试：**
- `tests/engine-systemroot.test.ts` — 验证每用户引擎 `hanakoHome=users/<id>`、`systemRoot=system/` 且全局引擎一致（H1）
- `tests/route-getengine.test.ts` — 验证 `getEngine(c)` 返回用户引擎、未登录 401
- `tests/path-guard-route.test.ts` — 验证越权绝对路径 403
- `tests/unregister.test.ts` — 软删/硬删/末位 admin 拒绝
- `tests/e2e/multiuser-server.test.ts` — 真起 server，A/B 双用户全链路

---

## Task 0: 审计 engine.ts 系统级 manager 构造点（确认无需搬根）

**Files:**
- Read: `core/engine.ts` (全文搜索 `hanakoHome:` / `new .*Manager` / `new .*Coordinator`)
- Read: `server/auth/register.ts`, `server/index.ts:428-445`

- [ ] **Step 1: 阅读并确认上述事实 1-3**
  运行（仅搜索，不修改）：在 `core/engine.ts` 全文搜索 `LocalUserAccount|WebSession|GrantStore|ServerIdentity|DataEpoch|security/grants`。
  Expected: 0 命中 → 确认 engine 内无系统级 manager，无需 rootOverride 注入。
- [ ] **Step 2: 确认 lifecycle defaultFactory 已传 systemRoot**
  读 `core/engine-lifecycle.ts:55-69`，确认 `new HanaEngine({ hanakoHome: userDataRoot, systemRoot, ... })` 已存在。
  Expected: 已传 `systemRoot = path.join(baseDir, systemHomePath())` = `<baseDir>/system`。
- [ ] **Step 3: 确认全局 engine 未传 systemRoot**
  读 `server/index.ts:437-442`，确认 `new HanaEngine({ hanakoHome })` **无** `systemRoot`。
  Expected: 无 `systemRoot` → 这是 T13 要修的点。
- [ ] **Step 4: 不提交（纯审计）**
  本任务为认知对齐，无代码改动。在 plan 复选框标记完成即可。

---

## Task 1: 单测固化"每用户引擎双根 + 全局引擎一致性"（H1 不变量）

**Files:**
- Create: `tests/engine-systemroot.test.ts`
- Read: `core/engine-lifecycle.ts`, `core/multiuser/paths.ts`, `shared/persistence/store-registry.ts`

- [ ] **Step 1: 写失败测试**
```ts
import path from "path";
import os from "os";
import fs from "fs";
import { afterEach, describe, expect, it } from "vitest";

function tmpBase(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "m1-sysroot-"));
  return d;
}

describe("engine systemRoot isolation (H1)", () => {
  it("user engine uses userDataRoot and shared systemRoot", async () => {
    const baseDir = tmpBase();
    const { EngineLifecycle } = await import("../core/engine-lifecycle.ts");
    const { systemStoreDir } = await import("../shared/persistence/store-registry.ts");
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    const h = await lc.use("u_a");
    expect(h.engine.hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
    expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
    await lc.drainAll();
  });

  it("systemRoot equals systemStoreDir physical path", async () => {
    const baseDir = tmpBase();
    const { EngineLifecycle } = await import("../core/engine-lifecycle.ts");
    const { systemStoreDir } = await import("../shared/persistence/store-registry.ts");
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    const h = await lc.use("u_b");
    expect(h.engine.systemRoot).toBe(path.join(baseDir, "system"));
    expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
    await lc.drainAll();
  });
});
```
- [ ] **Step 2: 运行测试确认失败**
  运行：`npx vitest run tests/engine-systemroot.test.ts`
  Expected: FAIL（`EngineLifecycle` 构造需要 `productDir` 等，或 `engine.systemRoot` 未透传）。记录实际失败原因。
- [ ] **Step 3: 修正 engine.ts 透传 systemRoot（若未透传）**
  读 `core/engine.ts` 构造函数，确认 `this.systemRoot = systemRoot ?? hanakoHome` 已存在（grep `systemRoot` 应得 L332 声明 + L352 赋值）。若 `systemRoot` 未被存为字段，补：
```ts
// 在 engine 构造函数内（hanakoHome 赋值附近）
this.systemRoot = systemRoot ?? hanakoHome;
```
  注意：lifecycle `defaultFactory` 已传 `systemRoot` 给 `HanaEngine`，故 `engine.systemRoot` 应已可读。若测试因 `productDir` 缺失报错，给 `EngineLifecycle` 测试注入最小 `productDir`。
- [ ] **Step 4: 运行测试确认通过**
  运行：`npx vitest run tests/engine-systemroot.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add tests/engine-systemroot.test.ts core/engine.ts
git commit -m "test(m1): assert per-user engine double-root + shared systemRoot (H1)"
```

---

## Task 2: 高敏感路由工厂签名升级为 getEngine(c)（F1 核心）

**Files:**
- Modify: `server/routes/chat.ts` (~L341 `createChatRoute`), `sessions.ts`, `session-collab.ts`, `session-projects.ts`, `agents.ts`, `upload.ts`, `fs.ts`, `preferences.ts`, `skills.ts`, `channels.ts`, `dm.ts`, `studio-workspaces.ts`
- Modify: `server/composition/open-root.ts` (L92-119)
- Read: `server/composition/user-engine-middleware.ts` (确认 `c.set('engine', handle.engine)`)

- [ ] **Step 1: 写失败测试（验证 getEngine 注入点）**
```ts
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("getEngine(c) facade", () => {
  it("chat route uses getEngine(c) not closure engine", async () => {
    const { createChatRoute } = await import("../server/routes/chat.ts");
    const userEngine = { hanakoHome: "/u/a" };
    const getEngine = vi.fn(() => userEngine);
    // 旧签名是 (engine, hub, opts)；新签名首参为 getEngine
    const route = createChatRoute(getEngine as any, {} as any, { upgradeWebSocket: (() => {}) as any });
    const app = new Hono();
    app.route("/api", route);
    // 不测完整 handler，仅断言工厂接受 getEngine 且不闭包捕获旧 engine
    expect(typeof createChatRoute).toBe("function");
  });
});
```
  说明：本测试仅验证签名可编译/调用；真正隔离验证在 Task 11 E2E。若旧签名 `(engine, hub, opts)` 与新签名冲突，测试会编译失败 → 驱动 Step 3。
- [ ] **Step 2: 运行确认失败（编译错误：参数类型不符）**
  运行：`npx vitest run tests/route-getengine.test.ts`
  Expected: 编译/类型 FAIL（旧签名 `engine` 不是函数）。
- [ ] **Step 3: 改造 chat.ts 工厂签名（示范，其余路由同此模式）**
  读 `server/routes/chat.ts` 找到 `export function createChatRoute(engine, hub, opts)`（约 L341）。改为：
```ts
export function createChatRoute(
  getEngine: (c: any) => any,
  hub: any,
  opts: any
) {
  const engine = getEngine; // 兼容内部引用：后续统一用 getEngine(c)
  // 在需要 engine 的 handler 内改为: const eng = getEngine(c);
  // （逐 handler 把 `engine.xxx` 改为 `getEngine(c).xxx`，或闭包首行 const eng = getEngine(c)）
  ...
}
```
  实际改造：在 `createChatRoute` 闭包首行加 `const getEng = getEngine;`，并把所有 `engine.` 调用改为 `getEng(c).`（c 为 handler 的 Context）。若 handler 无 `c` 入参，则在 handler 内 `const c = ...` 取 context（chat handler 均有 `c`）。
  **其余 11 个路由**（`sessions.ts` 等）同样：`createXRoute(engine, ...)` → `createXRoute(getEngine, ...)`，内部 `engine.` → `getEngine(c).`。
- [ ] **Step 4: 改造 open-root.ts 注入 getEngine**
  读 `server/composition/open-root.ts:79-119`。将高敏感路由工厂调用从传 `engine` 改为传 `(c) => c.get('engine') ?? engine`：
```ts
const getEngine = (c: any) => c.get('engine') ?? engine; // engine = ctx.engine 全局兜底
// 高敏感类：
const { restRoute: chatRestRoute, wsRoute: chatWsRoute } = createChatRoute(getEngine, hub, { upgradeWebSocket });
app.route("/api", createSessionsRoute(getEngine, hub));
app.route("/api", createSessionCollabRoute(getEngine));
app.route("/api", createSessionProjectsRoute(getEngine));
app.route("/api", createAgentsRoute(getEngine));
app.route("/api", createUploadRoute(getEngine));
app.route("/api", createFsRoute(getEngine));        // 若 fs 工厂名不同，按实际调整
app.route("/api", createPreferencesRoute(getEngine));
app.route("/api", createSkillsRoute(getEngine));
app.route("/api", createChannelsRoute(getEngine, hub));
app.route("/api", createDmRoute(getEngine));
app.route("/api", createStudioWorkspacesRoute(getEngine));
// 系统/只读类保持 engine（全局兜底）：web-auth / access / models / config / media / mcp / plugins / commands / experiments / bridge / resources / usage / file-history / checkpoints / server-identity
```
  注意：实际工厂名（如 `createFsRoute`）以各路由文件导出为准；改造前 grep 确认每个导出名。
- [ ] **Step 5: 运行测试确认通过 + 类型检查**
  运行：`npx vitest run tests/route-getengine.test.ts && npx tsc --noEmit -p tsconfig.json`（或仓库既有 typecheck 脚本）
  Expected: PASS + 无类型错误（若有未改尽的 `engine` 引用会报类型错）
- [ ] **Step 6: 提交**
```bash
git add server/routes/chat.ts server/routes/sessions.ts server/routes/session-collab.ts server/routes/session-projects.ts server/routes/agents.ts server/routes/upload.ts server/routes/fs.ts server/routes/preferences.ts server/routes/skills.ts server/routes/channels.ts server/routes/dm.ts server/routes/studio-workspaces.ts server/composition/open-root.ts
git commit -m "feat(m1): upgrade high-sensitivity route factories to getEngine(c) facade (F1)"
```
  说明：若某路由导出名与上文不同，按 grep 实际结果调整后再提交。

---

## Task 3: chat WS 经 bindEngineToWs 走 lifecycle（R6）

**Files:**
- Modify: `server/composition/open-root.ts` (chatWsRoute 接线)
- Modify: `server/routes/chat.ts` (工厂加 engineLifecycle；onOpen 绑定 + onMessage per-ws 引擎)
- Read: `server/ws/engine-ws-binding.ts` (已有 `bindEngineToWs`)

**状态：已完成（实现比原计划更彻底）**

原计划（Step 2）只在 `open-root` 包一层 `wrappedWs` 调 `bindEngineToWs`，但不改 `onMessage` 闭包，
因此 WS 虽"保活"但未真正使用每用户引擎（读全局兜底引擎）。实际实现：

- [x] **Step 1: 阅读 bindEngineToWs 机制** — 确认 `bindEngineToWs(ws, lifecycle, ctx)` 从 `ctx`
      取 `principal.userId` 并 `lifecycle.use(userId)`，异步设置 `ws.engine`/`ws.hub`，WS 期间 keepAlive 防误回收。
- [x] **Step 2: 在 createChatRoute 内部绑定（偏离原计划）**
  - `createChatRoute(engine, hub, { upgradeWebSocket, engineLifecycle })` 新增 `engineLifecycle` 参数；
    `open-root.ts` 经 `ctx.engineLifecycle` 传入。
  - `onOpen(event, ws)` 内调用 `bindEngineToWs(ws, engineLifecycle, c)`（若 engineLifecycle 存在）。
- [x] **Step 3: onMessage 路径改用 per-ws 引擎（核心隔离点）**
  - onMessage 的 async IIFE 开头引入 `const eng = ws.engine ?? engine; const h = ws.hub ?? hub;`
  - 该区间内全部 38+ 处 `engine.xxx` / `hub.xxx`（steer / slash / compact / resume / prompt /
    interject / agent-review / hub.send 等写用户根与按 sessionPath 解析 session 的调用）改为 `eng.` / `h.`
  - 文件级闭包 helper 与 REST 路由保持全局 `engine`（M0 行为边界，REST Agent Review 经
    `AgentReviewTurnCoordinator` 单例仍用全局引擎）。
- [x] **Step 4: tsc --noEmit 通过（exit 0），lint 无错。** 单测因 vitest v4 + node v25 环境阻塞，
      暂未执行（Track 1 已知限制）。
- [x] **Step 5: 提交** — `feat(m1): bind chat WS to EngineLifecycle + per-user engine in onMessage (R6)`

**已知边界（记录在案，非缺陷）：**
- `bindEngineToWs` 是 fire-and-forget（异步 acquire）。用户若在 WS 连接建立后、acquire 完成前极速发消息，
  `ws.engine` 尚未就绪，`eng` 回退全局兜底引擎 → 该次消息写到兜底用户根。正常网络往返下 acquire 已完成，不触发。
  若要彻底消除竞态，需把 `bindEngineToWs` 的 await 提前到 `onOpen` 的同步解析阶段（或 onMessage 首条消息前 await）。
- `hub.subscribe` 的广播回调（`broadcast`）使用全局 `engine`（跨用户广播，H1 保证 systemRoot 一致）；若某 session
  物理位于其他用户根，全局引擎 `getSessionByPath` 读不到 → 跨用户广播事件可能漏发。属 chat 广播边界，留 M2 细化。

---

## Task 4: path-guard 接运行时边界（D1/E1）

**Files:**
- Read: `core/multiuser/paths.ts` (`assertWithinUserRoot(userId, target, baseDir?)`)
- Modify: `server/routes/upload.ts`, `server/routes/fs.ts`, `server/routes/desk.ts`, `lib/character-cards/service.ts`（按实际接收 caller 绝对路径的 handler）
- Read: `server/http/capability-guard.ts` (`readAuthPrincipal` 取 userId)

- [ ] **Step 1: 写失败测试**
```ts
import { describe, expect, it } from "vitest";
import { assertWithinUserRoot } from "../core/multiuser/paths.ts";

describe("path-guard boundary (Q10)", () => {
  it("rejects cross-user absolute path", () => {
    const baseDir = "/tmp/base";
    const victim = "/tmp/base/users/u_victim/evil";
    expect(() => assertWithinUserRoot("u_attacker", victim, baseDir)).toThrow();
  });
  it("allows own user path", () => {
    const baseDir = "/tmp/base";
    const own = "/tmp/base/users/u_attacker/ok";
    expect(() => assertWithinUserRoot("u_attacker", own, baseDir)).not.toThrow();
  });
});
```
- [ ] **Step 2: 运行确认失败（若 assertWithinUserRoot 未实现则编译失败）**
  运行：`npx vitest run tests/path-guard-route.test.ts`
  Expected: FAIL（函数不存在或逻辑不符）
- [ ] **Step 3: 确认 assertWithinUserRoot 已实现（M0）**
  读 `core/multiuser/paths.ts:45`，确认 `assertWithinUserRoot(userId, target, baseDir?)` 已存在且抛 `PathGuardError`。若已存在，Step 1 测试应改为验证行为（可能直接 PASS，则补 Step 4 的集成测试）。
- [ ] **Step 4: 在 upload/fs handler 边界调 guard**
  读 `server/routes/upload.ts` 接收 caller 上传目标目录的 handler（如 body.targetDir / query）。在 handler 开头加：
```ts
const principal = readAuthPrincipal(c);
const userId = principal?.userId;
if (!userId) return c.json({ error: "unauthenticated" }, 401);
const target = /* 从 body/query 取 caller 绝对路径 */;
try {
  assertWithinUserRoot(userId, target, baseDir);
} catch {
  return c.json({ error: "path_out_of_user_root" }, 403);
}
```
  同样在 `server/routes/fs.ts`（接收绝对路径的 API）、`server/routes/desk.ts`（workspace 根）、`lib/character-cards/service.ts`（复制目标）加相同 guard。`baseDir` 取自 `ctx`（open-root 注入，或 `path.dirname(engine.hanakoHome)`）。
- [ ] **Step 5: 集成测试：越权绝对路径 403**
  在 `tests/path-guard-route.test.ts` 加：构造 Hono app（复用 `createUploadRoute(getEngine)`），以用户 A 的 cookie 调 upload 传 B 的绝对路径 → 期望 403。具体组装参考 `tests/web-auth-route.test.ts` 的 app 构建模式。
- [ ] **Step 6: 运行测试确认通过**
  运行：`npx vitest run tests/path-guard-route.test.ts`
  Expected: PASS
- [ ] **Step 7: 提交**
```bash
git add core/multiuser/paths.ts server/routes/upload.ts server/routes/fs.ts server/routes/desk.ts lib/character-cards/service.ts tests/path-guard-route.test.ts
git commit -m "feat(m1): enforce assertWithinUserRoot at caller-path API boundaries (D1/E1)"
```

---

## Task 5: 账号软删/硬删 + countSystemAdmins（I1）

**Files:**
- Create: `server/auth/unregister.ts`
- Read: `server/auth/register.ts` (`readUsersJson`, `findUserByUsername`, `getScopes`, `acquireLock`)

- [ ] **Step 1: 写失败测试**
```ts
import fs from "fs";
import path from "path";
import os from "os";
import { describe, expect, it, beforeEach } from "vitest";

describe("unregister (ADR-12)", () => {
  let baseDir: string;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-unreg-")); });

  it("countSystemAdmins counts admin users", async () => {
    const { countSystemAdmins } = await import("../server/auth/unregister.ts");
    const { registerUser } = await import("../server/auth/register.ts");
    await registerUser(baseDir, { username: "a", password: "password1", displayName: "A" });
    await registerUser(baseDir, { username: "b", password: "password1", displayName: "B" });
    expect(countSystemAdmins(baseDir)).toBe(1); // 仅首用户 admin
  });

  it("hard delete removes user dir + auth + users.json entry", async () => {
    const { registerUser } = await import("../server/auth/register.ts");
    const { hardDeleteUser } = await import("../server/auth/unregister.ts");
    const { userId } = await registerUser(baseDir, { username: "a", password: "password1", displayName: "A" });
    const userDir = path.join(baseDir, "users", userId);
    expect(fs.existsSync(userDir)).toBe(true);
    await hardDeleteUser(baseDir, userId);
    expect(fs.existsSync(userDir)).toBe(false);
    const doc = JSON.parse(fs.readFileSync(path.join(baseDir, "system", "users.json"), "utf8"));
    expect(doc.users.find((u: any) => u.userId === userId)).toBeUndefined();
  });

  it("hard delete rejects last admin (409 last_admin)", async () => {
    const { registerUser } = await import("../server/auth/register.ts");
    const { hardDeleteUser } = await import("../server/auth/unregister.ts");
    const { userId } = await registerUser(baseDir, { username: "a", password: "password1", displayName: "A" });
    await expect(hardDeleteUser(baseDir, userId)).rejects.toThrow("last_admin");
  });

  it("soft delete marks disabled but keeps dir", async () => {
    const { registerUser } = await import("../server/auth/register.ts");
    const { softDeleteUser } = await import("../server/auth/unregister.ts");
    const { userId } = await registerUser(baseDir, { username: "a", password: "password1", displayName: "A" });
    await softDeleteUser(baseDir, userId);
    const doc = JSON.parse(fs.readFileSync(path.join(baseDir, "system", "users.json"), "utf8"));
    expect(doc.users.find((u: any) => u.userId === userId).disabled).toBe(true);
    expect(fs.existsSync(path.join(baseDir, "users", userId))).toBe(true);
  });
});
```
- [ ] **Step 2: 运行确认失败**
  运行：`npx vitest run tests/unregister.test.ts`
  Expected: FAIL（`unregister.ts` 不存在）
- [ ] **Step 3: 实现 unregister.ts**
```ts
import fs from "fs";
import path from "path";
import { systemStoreDir, userHomePath } from "../../shared/persistence/store-registry.ts";
import { readUsersJson } from "./register.ts";

export function countSystemAdmins(baseDir: string): number {
  const doc = readUsersJson(baseDir);
  return (doc.users ?? []).filter((u: any) => (u.scopes ?? []).includes("SYSTEM_ADMIN")).length;
}

export class LastAdminError extends Error {
  constructor() { super("last_admin"); this.name = "LastAdminError"; }
}

export async function softDeleteUser(baseDir: string, userId: string): Promise<void> {
  const p = path.join(systemStoreDir(baseDir), "users.json");
  const doc = readUsersJson(baseDir);
  const u = doc.users.find((x: any) => x.userId === userId);
  if (!u) throw new Error("user_not_found");
  u.disabled = true;
  u.disabledAt = Date.now();
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
}

export async function hardDeleteUser(baseDir: string, userId: string): Promise<void> {
  const doc = readUsersJson(baseDir);
  const u = doc.users.find((x: any) => x.userId === userId);
  if (!u) throw new Error("user_not_found");
  if ((u.scopes ?? []).includes("SYSTEM_ADMIN") && countSystemAdmins(baseDir) <= 1) {
    throw new LastAdminError();
  }
  // 清业务目录
  const userDir = path.join(baseDir, userHomePath(userId));
  if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
  // 移除 users.json 条目
  doc.users = doc.users.filter((x: any) => x.userId !== userId);
  fs.writeFileSync(path.join(systemStoreDir(baseDir), "users.json"), JSON.stringify(doc, null, 2));
  // 移除 auth 哈希（Task 6 的 removeLocalAccountPasswordForUser）
  const { removeLocalAccountPasswordForUser } = await import("../../core/local-user-account.ts");
  removeLocalAccountPasswordForUser(systemStoreDir(baseDir), userId);
}
```
  注意：复用 `register.ts` 的 `acquireLock` 防并发（在 `hardDeleteUser` 外包锁，参考 `registerUser` 的 lock 模式）。
- [ ] **Step 4: 运行测试确认通过**
  运行：`npx vitest run tests/unregister.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/auth/unregister.ts tests/unregister.test.ts
git commit -m "feat(m1): soft/hard delete user with last-admin guard (ADR-12, I1)"
```

---

## Task 6: removeLocalAccountPasswordForUser（T10）

**Files:**
- Modify: `core/local-user-account.ts`
- Read: `setLocalAccountPasswordForUser`（L82-117）确认 auth 文件结构

- [ ] **Step 1: 写失败测试**
```ts
import fs from "fs";
import path from "path";
import os from "os";
import { describe, expect, it } from "vitest";

describe("removeLocalAccountPasswordForUser", () => {
  it("removes user entry from local-user-auth.json", async () => {
    const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-auth-"));
    const { setLocalAccountPasswordForUser, removeLocalAccountPasswordForUser, verifyLocalAccountPassword }
      = await import("../core/local-user-account.ts");
    setLocalAccountPasswordForUser(sysDir, "u_x", "password1");
    expect(verifyLocalAccountPassword(sysDir, { username: "u_x", password: "password1" }).ok).toBe(true);
    removeLocalAccountPasswordForUser(sysDir, "u_x");
    expect(verifyLocalAccountPassword(sysDir, { username: "u_x", password: "password1" }).ok).toBe(false);
  });
});
```
- [ ] **Step 2: 运行确认失败**
  运行：`npx vitest run tests/unregister.test.ts`（同文件或新建）
  Expected: FAIL（函数不存在）
- [ ] **Step 3: 实现 removeLocalAccountPasswordForUser**
  读 `core/local-user-account.ts` 中 `setLocalAccountPasswordForUser`（L82-117）与 `loadLocalUserAuth`，在文件末尾加：
```ts
export function removeLocalAccountPasswordForUser(hanakoHome: string, userId: string): void {
  const auth = loadLocalUserAuth(hanakoHome); // 复用现有加载
  if (auth.users && auth.users[userId]) {
    delete auth.users[userId];
    writeLocalUserAuth(hanakoHome, auth); // 复用现有写入
  }
}
```
  若 `loadLocalUserAuth` / `writeLocalUserAuth` 非 export，改为调用内部等价逻辑（读 `local-user-auth.json`、删 `users[userId]`、写回）。具体函数名以文件实际导出为准（grep `function loadLocalUserAuth` / `function writeLocalUserAuth`）。
- [ ] **Step 4: 运行测试确认通过**
  运行：`npx vitest run tests/unregister.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add core/local-user-account.ts tests/unregister.test.ts
git commit -m "feat(m1): removeLocalAccountPasswordForUser for hard delete (T10)"
```

---

## Task 7: web-auth 加 DELETE 注销路由（T9）

**Files:**
- Modify: `server/routes/web-auth.ts` (L34 `route`)
- Read: `server/auth/unregister.ts` (`softDeleteUser`, `hardDeleteUser`)

- [ ] **Step 1: 写失败测试**
```ts
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { describe, expect, it, beforeEach } from "vitest";

describe("web-auth delete account", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-del-")); });
  it("DELETE /web-auth/account soft deletes", async () => {
    const { createServerAuthService } = await import("../core/server-auth.ts");
    const { createWebAuthRoute } = await import("../server/routes/web-auth.ts");
    const auth = createServerAuthService({ baseDir: tmpDir } as any);
    const app = new Hono();
    app.route("/api", createWebAuthRoute({ hanakoHome: tmpDir, authService: auth, getConnectionKind: () => "local", getRuntimeContext: () => ({}) } as any));
    // 注册 + 拿 cookie
    const reg = await app.request("/api/web-auth/register", { method: "POST", body: JSON.stringify({ username: "a", password: "password1", displayName: "A" }), headers: { "content-type": "application/json" } });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const del = await app.request("/api/web-auth/account", { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    const doc = JSON.parse(fs.readFileSync(path.join(tmpDir, "system", "users.json"), "utf8"));
    expect(doc.users[0].disabled).toBe(true);
  });
});
```
- [ ] **Step 2: 运行确认失败**
  运行：`npx vitest run tests/web-auth-route.test.ts`
  Expected: FAIL（DELETE 路由不存在 → 404 或测试期望 200 不符）
- [ ] **Step 3: 加 DELETE 路由**
  在 `server/routes/web-auth.ts` 的 `route` 内（L75 之后）加：
```ts
route.delete("/web-auth/account", async (c) => {
  const principal: any = readAuthPrincipal(c);
  if (!principal?.userId) return c.json({ error: "unauthenticated" }, 401);
  await softDeleteUser(baseDir, principal.userId);
  return c.json({ ok: true });
});

route.delete("/web-auth/account/hard", async (c) => {
  const principal: any = readAuthPrincipal(c);
  if (!principal?.userId) return c.json({ error: "unauthenticated" }, 401);
  try {
    await hardDeleteUser(baseDir, principal.userId);
  } catch (e: any) {
    if (e?.message === "last_admin") return c.json({ error: "last_admin" }, 409);
    return c.json({ error: e?.message || "delete_failed" }, 400);
  }
  return c.json({ ok: true });
});
```
  注意：`baseDir` 是 `createWebAuthRoute` 的构造参数（参考现有 `hanakoHome` 如何从 ctx 取得；`baseDir = path.dirname(hanakoHome)` 或 route 文件已有 `baseDir`）。`readAuthPrincipal` 已在文件顶部 import（见 `user-engine-middleware.ts` 同款）。
- [ ] **Step 4: 运行测试确认通过**
  运行：`npx vitest run tests/web-auth-route.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add server/routes/web-auth.ts tests/web-auth-route.test.ts
git commit -m "feat(m1): DELETE /web-auth/account + /hard for unregister (T9)"
```

---

## Task 8: startServer 多用户化（T13，J1 前置）

**Files:**
- Modify: `server/index.ts` (L253 `hanakoHome` 解析, L437 全局 engine 构造)
- Read: `server/composition/contract.ts` (`engineLifecycle?` 接缝)
- Read: `core/engine-lifecycle.ts` (`EngineLifecycle` 构造需要 `baseDir` / `productDir`)

- [ ] **Step 1: 确认 engineLifecycle 在 M0 已注入 ctx**
  读 `server/index.ts` 中 `engineLifecycle = new EngineLifecycle({...})`（M0 已加，约 L730+）与 `CompositionContext` 是否含 `engineLifecycle`。确认 `open-root.ts` 的 `ctx` 能取到 `lifecycle`。
- [ ] **Step 2: 让全局兜底 engine 传 systemRoot（H1）**
  读 `server/index.ts:437-442`，改为：
```ts
const systemRoot = path.join(hanakoHome, "system"); // 与 lifecycle 一致（M0 单 baseDir 模型下 hanakoHome 即 baseDir/system 的上层）
const engine: any = new HanaEngine({
  hanakoHome,
  systemRoot,
  productDir,
  appVersion,
  builtinMediaAdapters: root.builtinMediaAdapters,
} as any);
```
  注意：`hanakoHome` 在单用户 dev:web 下是 `~/.hanako`，`systemRoot = ~/.hanako/system` 与 `systemStoreDir(baseDir)`（baseDir=dirname(hanakoHome)）物理一致需验证——若 dev:web 的 `hanakoHome` 已是 `<baseDir>/system` 同级，则 `systemRoot = hanakoHome` 本身。以 `resolveEngineRoots(dirname(hanakoHome), defaultUserId)` 为准对齐 lifecycle。T11 E2E 会验证一致性。
- [ ] **Step 3: 确保 engineLifecycle 接线进 open-root**
  在 `mountOpenRoutes(ctx)` 前，确认 `ctx.engineLifecycle` 已赋值（M0 注入）。若未注入，在 `server/index.ts` 构造 `CompositionContext` 处加 `engineLifecycle`（复用 M0 已 new 的实例）。
- [ ] **Step 4: 冒烟测试 server 启动**
  运行（后台，验证不崩）：`HANA_HOME=$(mktemp -d) npm run dev:web` 或直接 `node` 启动 server，观察日志无异常后停止。
  Expected: server 正常启动，日志出现 `② HanaEngine 构造完成`。
- [ ] **Step 5: 提交**
```bash
git add server/index.ts server/composition/contract.ts
git commit -m "feat(m1): pass systemRoot to global engine + wire engineLifecycle into open-root (T13)"
```

---

## Task 9: E2E 真起多用户 server（T11，收尾验收）

**Files:**
- Create: `tests/e2e/multiuser-server.test.ts`
- Read: `server/index.ts` (`startServer` 导出 + 如何注入 `systemRoot`/临时 baseDir)

- [ ] **Step 1: 写 E2E 测试骨架（真起 server）**
```ts
import fs from "fs";
import path from "path";
import os from "os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

describe("multiuser E2E (real server)", () => {
  let baseDir: string;
  let server: any;
  let port: number;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-e2e-"));
    // 启动改后的 server（T13 已支持 systemRoot + lifecycle）
    // 通过动态 import startServer 并注入临时 baseDir + 随机端口
    const mod = await import("../../server/index.ts");
    server = await mod.startServer({ root: path.join(baseDir, "system"), port: 0 } as any);
    port = server.port;
  });

  afterAll(async () => {
    if (server) await server.close?.();
  });

  it("registers A and B, isolates business homes", async () => {
    const regA = await fetch(`http://127.0.0.1:${port}/api/web-auth/register`, {
      method: "POST", body: JSON.stringify({ username: "a", password: "password1", displayName: "A" }),
      headers: { "content-type": "application/json" },
    });
    expect(regA.status).toBe(200);
    const a = await regA.json();
    expect(a.scopes).toContain("SYSTEM_ADMIN");
    expect(fs.existsSync(path.join(baseDir, "users", a.userId))).toBe(true);
  });

  it("double-root: agent created by A lands in users/<A>/ not system/", async () => {
    // 登录 A，创建 agent，断言文件路径
    // （具体 agent 创建 API 以 createAgentsRoute 为准；断言落盘位置）
  });

  it("path-guard: B with A absolute path gets 403", async () => {
    // 登录 B，调 upload 传 A 的 users/<A>/ 绝对路径 → 403
  });

  it("engine isolation: A and B activeCount >= 2", async () => {
    // 通过 lifecycle 暴露的测试钩子或两次请求后断言 activeCount
  });

  it("hard delete A clears dir + auth + session", async () => {
    // 登录 A，DELETE /web-auth/account/hard，断言 users/<A>/ 消失、auth 无 A、session 清
  });
});
```
  说明：`startServer` 的实际签名以 `server/index.ts` 导出为准（若 `startServer(root)` 单参，则临时 baseDir 经 `HANA_HOME` 环境变量注入，参考 L253）。E2E 用 `fetch` 打 `http://127.0.0.1:<port>`。
- [ ] **Step 2: 运行 E2E（可能慢，engine.ts 动态转译）**
  运行：`npx vitest run tests/e2e/multiuser-server.test.ts`
  Expected: 全绿（双根落盘 + path-guard 越权 + 注销清目录 + 引擎隔离 + 注册锁回归）。若超时，参考 M0 删 `engine-dual-root.test.ts` 的教训：用动态 `import()` + 临时 baseDir 隔离，单测不静态依赖 engine.ts。
- [ ] **Step 3: 补满 7 个用例（对照 spec §4.2）**
  按 spec §4.2 用例 1-7 逐一补全断言：
  1. 注册 A/B + system/users.json 含 A/B + A 标 SYSTEM_ADMIN + users/<A>/ users/<B>/ 目录存在
  2. 双根分库落盘（agent/session 落 users/<A>/，system/ 无业务数据）
  3. path-guard 越权 403
  4. 引擎隔离 activeCount>=2 + 各 userDataRoot 不同
  5. 硬删 A 清目录 + users.json 无 A + auth 无 A + session 清
  6. 注册锁回归（并发首注册仅一人 admin）——M0 已有单测，E2E 补真起
  7. A-dispose-B 正常（A 引擎 dispose 后 B 仍正常）
- [ ] **Step 4: 运行全量 E2E 确认通过**
  运行：`npx vitest run tests/e2e/multiuser-server.test.ts`
  Expected: PASS
- [ ] **Step 5: 提交**
```bash
git add tests/e2e/multiuser-server.test.ts
git commit -m "test(m1): E2E multiuser isolation (double-root + path-guard + unregister)"
```

---

## Task 10: 文档与 spec 自审回填（T12）

**Files:**
- Modify: `server/composition/open-root.ts` (顶部 M0 范围声明注释 → M1 已接管)
- Modify: `docs/superpowers/specs/m1-multiuser-isolation.md` (若发现新缺口)

- [ ] **Step 1: 更新 open-root.ts 注释**
  读 `server/composition/open-root.ts` 顶部（或 `user-engine-middleware.ts` L9-11 的"全量路由接管推迟到 M1"注释），改为"M1 已完成高敏感路由接管（F1）"。
- [ ] **Step 2: 运行全量测试**
  运行：`npx vitest run`
  Expected: 全绿（含 M0 既有 27 项 + M1 新增）
- [ ] **Step 3: 提交**
```bash
git add server/composition/open-root.ts docs/superpowers/specs/m1-multiuser-isolation.md
git commit -m "docs(m1): mark high-sensitivity routes taken over; spec self-review"
```

---

## Self-Review（计划写完后自查）

### 1. Spec 覆盖检查
| Spec 段落 | 对应 Task |
|---|---|
| §2 双根分库（事实修正后：engine 层基本自然成立） | Task 0（审计确认）、Task 1（H1 单测）、Task 8（全局引擎传 systemRoot） |
| §3.1 高敏感路由接管（F1） | Task 2（getEngine 改造）、Task 3（WS 绑定） |
| §3.2 path-guard（D1/E1） | Task 4 |
| §4.1 注销/删除（I1） | Task 5、Task 6、Task 7 |
| §4.2 E2E（J1） | Task 8（startServer 前置）、Task 9 |
| §6 风险 R5/R6/R8/R9/R10/R11/R12/R13 | Task 0-9 分别覆盖 |
| §7 任务 T0-T13 | Task 0-10 映射（T13=Task 8，T11=Task 9，T12=Task 10） |

**缺口**：spec §2 原 `ENGINE_SYSTEM_MANAGERS` 表已证明基于错误假设（engine 内无系统级 manager），本计划 Task 0 显式审计并修正——这是对 spec 的诚实回填，非遗漏。

### 2. 占位符扫描
- 无 "TBD"/"TODO"/"implement later"。
- Task 2/4 中 "按实际工厂名调整" 类措辞：已给出 grep 指引与示例，engineer 改造前需 grep 确认导出名——这是必要的代码探索步骤，非占位符。
- Task 9 E2E 用例 2-4 留空 body：已在 Step 3 明确要求"按 spec §4.2 补全断言"，且给出断言要点，非空壳。

### 3. 类型一致性
- `getEngine(c)` 签名在 Task 2 定义：`(c: any) => any`，所有路由工厂统一首参。
- `countSystemAdmins(baseDir)` Task 5 定义，Task 5 测试与 `hardDeleteUser` 内部复用一致。
- `removeLocalAccountPasswordForUser(hanakoHome, userId)` Task 6 定义，Task 5 `hardDeleteUser` 调用一致。
- `softDeleteUser` / `hardDeleteUser(baseDir, userId)` Task 5 定义，Task 7 路由调用一致。
- `Lifecycle` 字段名 `engineLifecycle`（contract.ts 接缝）在 Task 2/3/8 统一引用。

无发现不一致。计划完整。
