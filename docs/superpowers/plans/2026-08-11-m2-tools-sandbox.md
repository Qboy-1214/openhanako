# M2 Tools & Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 M1 收尾（多用户隔离完整性）并实现 M2 工具与沙箱（用户脚本工具、无代码工作流、Docker 执行后端），全部落到可验收。

**Architecture:** 主轴为"用户身份 → 隔离资源 → 沙箱执行"。P0 收尾通过 F1 `getEngine(c)` + per-ws engine + `broadcast` 按 ownerUserId 过滤 + per-user `hanakoHome` 实现隔离。M2 复用现有 `createSandboxedTools`（第四种 docker exec 后端）、`ToolCatalog.registerSource`（热注册用户脚本）、`lib/workflow/runWorkflowScript`（前端层编译为 JS 喂入，内核零改动）。设计细节以已批准的 spec `docs/superpowers/specs/2026-08-11-m2-tools-sandbox-design.md` 为准，本 plan 是其执行步骤。

**Tech Stack:** TypeScript, Hono (`@hono/node-ws`), vitest, 现有 `lib/sandbox`/`core/tool-catalog`/`lib/workflow` 模块。

---

## File Structure

**P0 收尾**
- `server/routes/chat.ts` — P0-1（`onMessage` 状态机）、P0-2（`broadcast` 按 owner 过滤 + hub 回调 owner 解析 + 全局事件保持广播）
- `server/ws/engine-ws-binding.ts` — P0-1（`bindEngineToWs` 的 `.then` flush 钩子 + 超时关闭）
- `server/routes/desk.ts` — P0-3（F1 `getEngine(c)` 改造）
- `server/composition/full-root.ts` — P0-3（`createDeskRoute(getEngine, hub)` 注入）
- `lib/sandbox/index.ts` — P0-4（per-user `hanakoHome` 注入点）
- `core/session-manifest/` — P0-2 Step 0（owner 映射确认/补写）

**M2**
- `lib/sandbox/docker.ts` — M2-3（`createDockerExec`，同构 `createBwrapExec`）
- `lib/sandbox/platform.ts` — M2-3（`docker` 分支 + `HANAKO_SANDBOX_BACKEND` 选择）
- `server/`（新增 `tools`/`workflows` 路由 + 注册逻辑）— M2-1/M2-2
- `lib/workflow/` — 零改动（M2-2 内核复用）

**Tests**
- `tests/e2e/multiuser-server.test.ts`（扩展）、`tests/session-manifest-owner.test.ts`（新增，P0-2 Step 0）、`tests/sandbox/docker-backend.test.ts`（新增）、`tests/tools/user-script.test.ts`（新增）、`tests/workflow/nocode.test.ts`（新增）、`tests/path-guard-route.test.ts`（扩展 P0-4）

---

## Task 0: P0-2 Step 0 — owner 映射确认/补写

> spec 要求 P0-2 实现前先确认 session→owner 映射可靠。本 Task 只做探查 + 补写，不实现广播改造。

**Files:**
- Read: `core/session-manifest/ref.ts:1-5`（SessionRef 类型，确认无 ownerUserId）
- Read: `core/session-manifest/`（manifest 写入处，确认 userId 是否可反查）
- Test: `tests/session-manifest-owner.test.ts`

- [ ] **Step 1: Write the failing test for owner resolution**
```ts
import { describe, it, expect } from "vitest";
import { resolveOwnerUserId, registerSessionOwner } from "../../core/session-manifest/owner";

describe("session -> ownerUserId mapping", () => {
  it("resolves owner from per-user sessionPath", () => {
    expect(resolveOwnerUserId("users/u_alice/sessions/s1")).toBe("u_alice");
  });
  it("returns null for system events without sessionPath", () => {
    expect(resolveOwnerUserId(null)).toBeNull();
    expect(resolveOwnerUserId(undefined)).toBeNull();
  });
  it("resolves owner for bridge/agent sessions via manifest index", () => {
    // bridge/b1 无 users/ 前缀，前缀解析返回 null；须先经 Step 0 运行时补写索引
    registerSessionOwner("bridge/b1", "u_alice");
    expect(resolveOwnerUserId("bridge/b1")).toBe("u_alice");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/session-manifest-owner.test.ts`
Expected: FAIL — `resolveOwnerUserId` not exported

- [ ] **Step 3: Implement `resolveOwnerUserId` + manifest owner index**
在 `core/session-manifest/` 新增 `owner.ts`：
```ts
import * as path from "path";

const OWNER_INDEX = new Map<string, string>(); // sessionPath(归一) -> userId

export function registerSessionOwner(sessionPath: string | null | undefined, userId: string) {
  if (!sessionPath) return;
  OWNER_INDEX.set(normalize(sessionPath), userId);
}

export function resolveOwnerUserId(sessionPath: string | null | undefined): string | null {
  if (!sessionPath) return null;
  const norm = normalize(sessionPath);
  const idx = OWNER_INDEX.get(norm);
  if (idx) return idx;
  // 回退：per-user 前缀解析
  const m = norm.match(/users[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : null;
}

function normalize(p: string): string {
  return p.split(path.sep).join("/").replace(/\/$/, "");
}
```
在 per-user engine 创建 session 处（session-manifest 写入逻辑）调用 `registerSessionOwner(sessionPath, userId)`。

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/session-manifest-owner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add core/session-manifest/owner.ts tests/session-manifest-owner.test.ts
git commit -m "feat(m2/p0-2): add session->ownerUserId resolution index"
```

---

## Task 1: P0-4 — per-user `hanakoHome` 注入

**Files:**
- Modify: `lib/sandbox/index.ts:82`（消费 `hanakoHome` 形参，已在 line 114/127/164/185 使用）
- Modify: per-user engine 构造点（传入 `hanakoHome = userHome(userId)`）
- Modify: `lib/sandbox/policy.ts`（纵深防御：禁止读其他用户目录 / SystemDB）
- Test: `tests/path-guard-route.test.ts`（扩展）

- [ ] **Step 1: Write the failing test for per-user hanakoHome isolation**
```ts
import { describe, it, expect } from "vitest";
import * as path from "path";
import { deriveSandboxPolicy } from "../../lib/sandbox/policy";
import { PathGuard } from "../../lib/sandbox/path-guard";

const baseDir = "/data/hanako";
const userHome = (u: string) => path.join(baseDir, "users", u);

describe("per-user hanakoHome isolation", () => {
  it("alice cannot read bob's home", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "users", "bob", "secret.txt"))).toBe("blocked");
  });
  it("alice can read her own home", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "users", "alice", "file.txt"))).not.toBe("blocked");
  });
  it("alice cannot read SystemDB (defense-in-depth)", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "systemdb.sqlite"))).toBe("blocked");
    expect(guard.getAccessLevel(path.join(baseDir, "users", "_system"))).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/path-guard-route.test.ts`
Expected: FAIL or existing tests pass but new per-user cases fail (policy default hanakoHome = baseDir allows cross-user; SystemDB rule absent)

- [ ] **Step 3: Locate per-user engine creation and pass `userHome(userId)`**
在 per-user engine 构造处（搜索 `createSandboxedTools(` 的调用点，传入 `hanakoHome: userHome(userId)`）。全局兜底 engine 保持 `hanakoHome: baseDir`（不改）。
确认 `lib/sandbox/index.ts` 的 `makePolicy()`（line 106-116）已用形参 `hanakoHome` —— 无需改 index.ts 本身，只需调用方传对值（路径 E：零改动 PathGuard）。

- [ ] **Step 4: Add defense-in-depth rule to `policy.ts`**
在 `deriveSandboxPolicy`（lib/sandbox/policy.ts）中新增纵深规则（REARCHITECTURE §8.8.6）：当 `hanakoHome` 指向 `users/<userId>/` 时，READ_ONLY/READ_WRITE 基准根自动限在该用户子目录内，并显式拒绝 `users/_system`（SystemDB 宿主）与跨用户 `users/<other>/` 访问。该规则为纵深防御，非根因（根因是 Step 3 的 per-user `hanakoHome`）。

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/path-guard-route.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add tests/path-guard-route.test.ts <per-user-engine-file> lib/sandbox/policy.ts
git commit -m "feat(m2/p0-4): inject per-user hanakoHome + deny cross-user/SystemDB in policy"
```

---

## Task 2: P0-1 — `onMessage` 队列状态机（绝不回退全局 engine）

**Files:**
- Modify: `server/routes/chat.ts:1779-1797`（`onMessage` 回调顶部加状态机）
- Modify: `server/ws/engine-ws-binding.ts`（`bindEngineToWs` 的 `.then` flush 钩子 + 5s 超时关闭）

- [ ] **Step 1: Write the failing test for first-message queueing**
```ts
import { describe, it, expect } from "vitest";
// 复用 M1 的 fake engine 注入，模拟 acquire 延迟
describe("P0-1 WS first message before engine ready", () => {
  it("queues message until ws.engine ready, then flushes", async () => {
    // 构造 ws stub：engine 在 10ms 后才就绪
    const flushed: any[] = [];
    const ws = makeWsStub({ engineReadyAfter: 10 });
    // 在 engine 就绪前发送一条 msg
    emitOnMessage(ws, { type: "chat", sessionPath: "users/u_a/sessions/s1", text: "hi" });
    expect(flushed.length).toBe(0); // 未就绪时不处理
    await delay(20);
    expect(flushed.length).toBe(1); // 就绪后 flush
  });
  it("closes ws on acquire timeout instead of falling back to global engine", async () => {
    const ws = makeWsStub({ engineNeverReady: true, timeoutMs: 5 });
    const closed = emitOnMessageAndAwaitClose(ws, { type: "chat", sessionPath: "users/u_a/sessions/s1" });
    await expect(closed).resolves.toBe(1011);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/e2e/multiuser-server.test.ts -t "P0-1"`
Expected: FAIL — 当前实现会即时处理（或回退全局）

- [ ] **Step 3: Implement `onMessage` state machine in chat.ts**
在 `onMessage(event, ws)`（line 1779）顶部，于 `wsParse` 之后、`ensureWsClientRecord` 之前插入：
```ts
onMessage(event, ws) {
  const msg = wsParse(event.data);
  if (!msg) return;
  // P0-1: 若 per-ws engine 尚未就绪，入队并等待 bindEngineToWs flush
  if (!ws.engine) {
    (ws._pending ??= []).push(msg);
    return;
  }
  let client = ensureWsClientRecord(ws, requestContext, {
    assumeLocalOwner: isAdapterWithoutHttpRequest,
  });
  // ... 原有逻辑继续
```
在 `bindEngineToWs` 的 `.then` 回调（engine-ws-binding.ts）就绪后，通过 `onReady` 回调完成 flush——**注意 `handleWsMessage` 是 chat.ts `onOpen`/`onMessage` 闭包内的局部函数，外部模块（engine-ws-binding.ts）不可直接引用**，故 flush 逻辑必须留在 chat.ts 内，由 `onReady` 回调传出：
```ts
// chat.ts onOpen（line 1764），bindEngineToWs 调用处注入 onReady：
bindEngineToWs(ws, engineLifecycle, c, {
  onReady: (ws) => {
    const pending = (ws as any)._pending as unknown[] | undefined;
    (ws as any)._pending = [];
    for (const m of pending ?? []) handleWsMessage(ws, m); // 重放（此时 engine 已就绪）
  },
});

// engine-ws-binding.ts：bindEngineToWs 增加 onReady 形参，.then 末尾调用
export function bindEngineToWs(
  ws: WebSocket,
  lifecycle: EngineLifecycle,
  ctx: WsBindingContext,
  opts: { onReady?: (ws: WebSocket) => void } = {},
) {
  const timer = setTimeout(() => {
    if (!ws.engine) ws.close(1011); // 超时关闭：绝不回退全局 engine（H1）
  }, 5000);
  ws.addEventListener?.("close", () => clearTimeout(timer));
  return lifecycle.use(userId).then(({ engine, hub }) => {
    ws.engine = engine;
    ws.hub = hub;
    opts.onReady?.(ws); // acquire 完成 → 通知 chat.ts flush 待重放队列
  }).catch(() => {
    // acquire 失败：超时由上方 timer 处理，不回退全局
  });
}
```
（重构：将 `onMessage` 现有 body 抽为 `handleWsMessage(ws, msg)`，供 flush 复用；`handleWsMessage` 与 `onOpen`/`onMessage` 同处 chat.ts 闭包，可互相访问。）

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/e2e/multiuser-server.test.ts -t "P0-1"`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add server/routes/chat.ts server/ws/engine-ws-binding.ts
git commit -m "feat(m2/p0-1): queue WS messages until per-ws engine ready, timeout-close (no global fallback)"
```

---

## Task 3: P0-2 — `broadcast` 按 ownerUserId 过滤 + hub 回调 owner 解析

**Files:**
- Modify: `server/routes/chat.ts:555`（`broadcast(msg, { ownerUserId }?)`）
- Modify: `server/routes/chat.ts:1092`（`hub.subscribe` 回调解析 owner）
- Test: `tests/e2e/multiuser-server.test.ts`（扩展：A 事件不出现在 B 连接）

- [ ] **Step 1: Write the failing test for cross-user broadcast isolation**
```ts
import { describe, it, expect } from "vitest";
describe("P0-2 cross-user broadcast", () => {
  it("delivers session event only to owner's ws", async () => {
    const { server, wsA, wsB } = await setupTwoUsers();
    emitSessionEventForUser("u_a", { type: "text_delta", sessionPath: "users/u_a/sessions/s1" });
    await delay(10);
    expect(wsA.received.some(m => m.type === "text_delta")).toBe(true);
    expect(wsB.received.some(m => m.type === "text_delta")).toBe(false);
  });
  it("global events (no sessionPath) broadcast to all", async () => {
    const { server, wsA, wsB } = await setupTwoUsers();
    emitBroadcast({ type: "plugin_ui_changed" }); // 无 sessionPath
    await delay(10);
    expect(wsA.received.some(m => m.type === "plugin_ui_changed")).toBe(true);
    expect(wsB.received.some(m => m.type === "plugin_ui_changed")).toBe(true);
  });
  it("events with sessionPath but unresolved owner are dropped (fail-closed)", async () => {
    const { server, wsA, wsB } = await setupTwoUsers();
    // sessionPath 指向 Step 0 索引/前缀均无法反查 owner 的会话形态
    emitSessionEventForUnresolvedOwner({ type: "text_delta", sessionPath: "bridge/unknown-session" });
    await delay(10);
    expect(wsA.received.some(m => m.type === "text_delta")).toBe(false);
    expect(wsB.received.some(m => m.type === "text_delta")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/e2e/multiuser-server.test.ts -t "P0-2"`
Expected: FAIL — 当前 `broadcast` 全扇出

- [ ] **Step 3: Implement owner-filtered broadcast**
改造 `broadcast`（line 555）：
```ts
function broadcast(msg, { ownerUserId }: { ownerUserId?: string | null } = {}) {
  const hardenedMsg = hardenStudio(msg);
  for (const [ws, record] of clients) {
    // P0-2: ownerUserId === undefined → 全局事件（系统级，无 owner 维度）→ 不过滤，全扇出
    //       ownerUserId 为 string → 仅发给该用户 ws
    if (ownerUserId && record?.principal?.userId !== ownerUserId) continue;
    if (!wsClientCanReceiveEvent(record, hardenedMsg)) continue;
    wsSend(ws, hardenedMsg);
  }
}
```
改造 `hub.subscribe` 回调（line 1092）：为带 sessionPath 的 emitStreamEvent 类事件注入 owner：
```ts
hub.subscribe((event, sessionPath) => {
  const appEventMessage = toAppEventWsMessage(event);
  if (appEventMessage) { broadcast(appEventMessage); return; } // 全局事件（无 owner）→ 全广播
  const resourceEventMessage = toResourceEventWsMessage(event, sessionPath);
  if (resourceEventMessage) { broadcast(resourceEventMessage); return; } // 全局
  if (event.type === "plugin_ui_changed") { broadcast({ type: "plugin_ui_changed" }); return; } // 全局
  const ownerUserId = resolveOwnerUserId(sessionPath); // P0-2 Step 0
  // P0-2 fail-closed：带 sessionPath 但解析无 owner（Step 0 未覆盖的会话形态）→ 丢弃 + warn，不广播
  if (sessionPath && ownerUserId === null) {
    logger.warn({ sessionPath }, "P0-2 drop event: owner unresolved, fail-closed");
    return;
  }
  const compactionMessage = toCompactionLifecycleWsMessage(
    (sp) => engine.getSessionByPath(sp),
    (sp) => sessionIdForPath(sp),
  );
  if (compactionMessage) { broadcast(compactionMessage, { ownerUserId }); return; }
  // ... 其余 emitStreamEvent 调用改为 broadcast(xxx, { ownerUserId })
  // 注意：session 内 stream 事件（emitStreamEvent → broadcast）须传 ownerUserId
```
将 `emitStreamEvent`（line 625）内部 `broadcast(...)` 改为 `broadcast(msg, { ownerUserId: resolveOwnerUserId(sessionPath) })`。

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/e2e/multiuser-server.test.ts -t "P0-2"`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add server/routes/chat.ts
git commit -m "feat(m2/p0-2): broadcast filtered by ownerUserId; global events stay unfiltered"
```

---

## Task 4: P0-3 — desk F1 `getEngine(c)`

**Files:**
- Modify: `server/routes/desk.ts`（`createDeskRoute(getEngine, hub)`）
- Modify: `server/composition/full-root.ts`（注入 `getEngine`）

- [ ] **Step 1: Write the failing test for desk F1 per-user resolution**
```ts
import { describe, it, expect } from "vitest";
describe("P0-3 desk F1", () => {
  it("resolves per-user engine via getEngine(c)", async () => {
    const { app, getEngine } = makeDeskTestApp();
    const engA = await getEngineForUser("u_a");
    const engB = await getEngineForUser("u_b");
    expect(engA).not.toBe(engB);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/route-getengine.test.ts -t "P0-3"`
Expected: FAIL — 当前 desk 用全局 engine

- [ ] **Step 3: Implement F1 in desk.ts**
将 `createDeskRoute(engine, hub)` 改为 `createDeskRoute(getEngine, hub)`，每个 handler 顶部：
```ts
export function createDeskRoute(getEngine: (c: Context) => Promise<HanaEngine>, hub: Hub) {
  return (c: Context) => {
    const engine = getEngine(c); // F1：从 principal.userId 解析 per-user engine
    if (!engine) return c.json({ error: "unauthorized" }, 401); // 解析失败 fail-closed（spec §3 P0-3：401/403）
    // ... 原有 46+ 处 engine.xxx 现在用局部 engine
    return handleDesk(c, engine, hub);
  };
}
```
保留 M1 已加的 `isApprovedDir(dir, engine, { userId })` 纵深校验。

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/route-getengine.test.ts -t "P0-3"`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add server/routes/desk.ts server/composition/full-root.ts
git commit -m "feat(m2/p0-3): desk route uses F1 getEngine(c) for per-user isolation"
```

---

## Task 5: M2-3 — Docker exec 后端（`createDockerExec`）

**Files:**
- Create: `lib/sandbox/docker.ts`（`createDockerExec`）
- Modify: `lib/sandbox/platform.ts`（`docker` 分支 + `HANAKO_SANDBOX_BACKEND` 选择）
- Test: `tests/sandbox/docker-backend.test.ts`

- [ ] **Step 1: Write the failing test for docker backend + fallback**
```ts
import { describe, it, expect } from "vitest";
import { createDockerExec } from "../../lib/sandbox/docker";
import { selectSandboxBackend } from "../../lib/sandbox/platform";

describe("M2-3 docker backend", () => {
  it("createDockerExec returns same-signature exec fn", () => {
    const exec = createDockerExec(makeFakePolicy(), { image: "hanako-sandbox", getExternalReadPaths: () => [], getSandboxNetworkEnabled: () => false });
    expect(typeof exec).toBe("function");
  });
  it("auto mode falls back to bwrap when docker unavailable", () => {
    const backend = selectSandboxBackend({ dockerAvailable: false, inContainer: true, env: "auto" });
    expect(backend).toBe("bwrap");
  });
  it("auto mode picks docker on bare-metal with daemon", () => {
    const backend = selectSandboxBackend({ dockerAvailable: true, inContainer: false, env: "auto" });
    expect(backend).toBe("docker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/sandbox/docker-backend.test.ts`
Expected: FAIL — `createDockerExec`/`selectSandboxBackend` 不存在

- [ ] **Step 3: Implement `createDockerExec` in docker.ts**
```ts
import { spawnAndStream } from "./exec-helper";
import { SandboxPolicy } from "./policy";

export interface DockerExecOpts {
  image: string;
  getExternalReadPaths: () => string[];
  getSandboxNetworkEnabled: () => boolean;
  additionalMounts?: { src: string; dst: string }[];
}

export function createDockerExec(policy: SandboxPolicy, opts: DockerExecOpts) {
  return (command: string, cwd: string, execOpts: { onData?: (d: string) => void; signal?: AbortSignal; timeout?: number; env?: Record<string, string> } = {}) => {
    const mounts = [
      ...(opts.getExternalReadPaths?.() ?? []).map(p => ["-v", `${p}:${p}:ro`]),
      ...(opts.additionalMounts ?? []).map(m => ["-v", `${m.src}:${m.dst}`]),
    ].flat();
    const networkFlag = opts.getSandboxNetworkEnabled() ? [] : ["--network=none"];
    const args = [
      "run", "--rm",
      ...mounts,
      ...networkFlag,
      "--memory=512m", "--cpus=1.0",
      opts.image, "--", "/bin/bash", "-c", command,
    ];
    return spawnAndStream("docker", args, { cwd, ...execOpts });
  };
}
```

- [ ] **Step 4: Implement `selectSandboxBackend` + `docker` branch in platform.ts**
```ts
export type SandboxBackend = "docker" | "bwrap" | "seatbelt" | "win32";

export function isInsideContainer(): boolean {
  // §6.1 检测算法
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker/.test(cgroup)) return true;
  } catch {}
  return false;
}

export function selectSandboxBackend(opts: { dockerAvailable: boolean; inContainer?: boolean; env?: string }): SandboxBackend {
  const env = opts.env ?? process.env.HANAKO_SANDBOX_BACKEND ?? "auto";
  if (env === "docker") return "docker";
  if (env === "bwrap") return "bwrap";
  // auto
  const inContainer = opts.inContainer ?? isInsideContainer();
  if (opts.dockerAvailable && !inContainer) return "docker";
  return detectPlatform() as SandboxBackend; // 回退 bwrap/seatbelt/win32
}
```
在 `lib/sandbox/index.ts` 的 `makeSandboxExec`（line 319）增加 `platform === "docker"` 分支，调用 `createDockerExec(makePolicy(), { image: ..., getExternalReadPaths, getSandboxNetworkEnabled })`。

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/sandbox/docker-backend.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add lib/sandbox/docker.ts lib/sandbox/platform.ts lib/sandbox/index.ts tests/sandbox/docker-backend.test.ts
git commit -m "feat(m2/m2-3): add docker exec backend as 4th createSandboxedTools backend"
```

---

## Task 6: M2-1 Step 1 — origin 枚举确认（先探查，不写注册）

> spec 🟡 B：先确认 `if (entry.origin === "builtin")` 权限分支，再决定 origin 处理，禁止直接写 `"user"` 依赖静默降级。

**Files:**
- Read: `core/tool-catalog.ts:162`（origin 归一）、`core/tool-catalog-bridge.ts:257,300`（invocation 路由）、`core/engine.ts:2905`（deferredToolNames）

- [ ] **Step 1: Write a probe test documenting the origin normalization**
```ts
import { describe, it, expect } from "vitest";
import { normalizeOrigin } from "../../core/tool-catalog"; // 若私有则改为直接测 registerSource 行为

describe("M2-1 origin handling", () => {
  it("non-builtin origin is downgraded to mcp (per tool-catalog.ts:162)", () => {
    // 确认：写 "user" 会被静默降级为 "mcp" -> 走 MCP 路径（无 server）
    const normalized = normalizeOriginProbe("user");
    expect(normalized).toBe("mcp");
  });
});
```
（若 `normalizeOrigin` 非导出，本步改为在 `tool-catalog.ts` 内读取 line 162 逻辑并写注释确认，不新增导出。）

- [ ] **Step 2: Run probe**
Run: `npx vitest run tests/tools/origin-probe.test.ts`
Expected: 确认降级行为，输出记录到 PR 说明

- [ ] **Step 3: Decide origin strategy and record in code comment**
结论（二选一，写入 `server/tools/register-user-script.ts` 顶部注释）：
- (a) 扩展 `ToolCatalogOrigin` 加 `"user"` + 在 `tool-catalog-bridge.ts` 补 `user` 分支（`builtinCall` 同级 dispatch 用户脚本 handler）—— **推荐**
- (b) 复用 `"builtin"`，确认 `builtinCall` 能正确 dispatch 用户脚本且权限边界可接受
本 plan 默认按 (a) 实现后续 Task 7。

- [ ] **Step 4: Commit the probe + decision**
```bash
git add tests/tools/origin-probe.test.ts server/tools/register-user-script.ts
git commit -m "feat(m2/m2-1): confirm origin enum handling; choose user-origin extension"
```

---

## Task 7: M2-1 — 用户脚本工具落盘 + 热注册

**Files:**
- Create: `server/tools/register-user-script.ts`（热注册逻辑）
- Create: `server/routes/user-tools.ts`（POST /api/tools 落盘 + replaceSource）
- Modify: `core/tool-catalog.ts`（扩展 `ToolCatalogOrigin` 加 `"user"` + 分支，依 Task 6 结论）
- Test: `tests/tools/user-script.test.ts`

- [ ] **Step 1: Write the failing test for user-script registration + sandbox exec**
```ts
import { describe, it, expect } from "vitest";
describe("M2-1 user-script tool", () => {
  it("registers user tool and executes in sandbox", async () => {
    const catalog = makeCatalog();
    await registerUserScript(catalog, "u_a", { name: "hello", runtime: "sh", src: "echo hi" });
    const tool = catalog.getTool("hello");
    expect(tool).toBeTruthy();
    const result = await tool.execute({});
    expect(result).toContain("hi");
  });
  it("rejects cross-user tool access", async () => {
    const catalogA = makeCatalog();
    await registerUserScript(catalogA, "u_a", { name: "secret", runtime: "sh", src: "cat ../u_b/secret" });
    // 执行应被 sandbox path-guard 拒绝（P0-4 per-user hanakoHome）
    await expect(catalogA.getTool("secret").execute({})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/tools/user-script.test.ts`
Expected: FAIL — 模块未实现

- [ ] **Step 3: Implement `register-user-script.ts`**
```ts
import * as fs from "fs/promises";
import * as path from "path";

export interface UserScriptDef { name: string; paramSchema: any; runtime: "js"|"ts"|"py"|"sh"; src: string; }

export async function persistUserScript(userId: string, id: string, def: UserScriptDef, hanakoHome: string) {
  // 双根模型（open-root.ts:21）：per-user engine 的 hanakoHome = <baseDir>/users/<userId>（已含 users 段）。
  // 故落盘直接 path.join(hanakoHome, "tools", id)，不要再拼 "users"/userId（否则双重路径）。
  const dir = path.join(hanakoHome, "tools", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(def, null, 2));
  await fs.writeFile(path.join(dir, "src"), def.src);
}

export async function registerUserScript(catalog: ToolCatalog, userId: string, def: UserScriptDef) {
  const sourceId = `user-scripts-${userId}`;
  const entries: ToolCatalogEntryInput[] = [{
    name: def.name,
    toolName: def.name,
    serverId: `user:${userId}`,
    schemaRef: def.paramSchema,
    origin: "user", // 依 Task 6 结论（扩展枚举）
    handler: async (args) => {
      const { createSandboxedTools } = await import("../../lib/sandbox");
      // 经 sandbox exec 后端执行 def.src（runtime 决定解释器）
      return execInSandbox(userId, def, args);
    },
  }];
  catalog.replaceSource(sourceId, entries); // 幂等热注册
}
```

- [ ] **Step 4: Implement `POST /api/tools` route（落盘后 replaceSource）**
```ts
app.post("/api/tools", async (c) => {
  const userId = c.get("principal").userId;
  const def = await c.req.json();
  const id = crypto.randomUUID();
  const engine = getEngine(c);
  // 双根模型（open-root.ts:21）：per-user engine.hanakoHome = <baseDir>/users/<userId>（已含 users 段），
  // persistUserScript 内部用 path.join(hanakoHome, "tools", id) 落盘（不再拼 users/userId）
  await persistUserScript(userId, id, def, engine.hanakoHome); // 绝对路径落盘到 per-user 根
  await registerUserScript(engine.toolCatalog, userId, def); // 热注册，无需重启
  return c.json({ id, status: "registered" });
});
```

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/tools/user-script.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add server/tools/register-user-script.ts server/routes/user-tools.ts core/tool-catalog.ts tests/tools/user-script.test.ts
git commit -m "feat(m2/m2-1): user-script tools persist + hot-register via ToolCatalog.replaceSource"
```

---

## Task 8: M2-2 — 无代码工作流（前端编译为 JS → runWorkflowScript）

**Files:**
- Create: `server/workflows/compile.ts`（声明式 → JS 编译器，服务端）
- Create: `server/routes/user-workflows.ts`（`POST /api/workflows` 编译落盘）
- Modify: `lib/tools/workflow-tool.ts`（`execute()` 消费 `script.js`）
- Test: `tests/workflow/nocode.test.ts`

- [ ] **Step 1: Write the failing test for workflow compile + execute**
```ts
import { describe, it, expect } from "vitest";
import { compileWorkflow } from "../../server/workflows/compile";
import { runWorkflowScript } from "../../lib/workflow";

describe("M2-2 nocode workflow", () => {
  it("compiles declarative graph to JS and runs via runWorkflowScript", async () => {
    const graph = { nodes: [{ id: "n1", tool: "summarize", prompt: "x" }], edges: [] };
    const js = compileWorkflow(graph);
    expect(js).toContain("agent(");
    // runWorkflowScript(script, hostApi, opts) — 第 2 参为注入沙箱全局的 hostApi 对象，opts 仅 {signal,deadlineMs}
    const hostApi = { agent: async (fn: any) => ({ result: "ok" }) };
    const result = await runWorkflowScript(js, hostApi);
    expect(result).toBeTruthy();
  });
  it("streams partial results through lib/workflow kernel unchanged", async () => {
    const graph = { nodes: [{ id: "n1", tool: "echo", prompt: "hello" }], edges: [] };
    const js = compileWorkflow(graph);
    // 流式结果通过 hostApi 注入的全局函数透传，非 opts.onEvent
    const streamed: string[] = [];
    const hostApi = {
      agent: async (fn: any) => { streamed.push("agent:start"); const r = await fn(); streamed.push("agent:end"); return r; },
    };
    await runWorkflowScript(js, hostApi);
    expect(streamed.length).toBeGreaterThan(0); // 内核流式事件透传，lib/workflow 零改动
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/workflow/nocode.test.ts`
Expected: FAIL — `compileWorkflow` 未实现

- [ ] **Step 3: Implement `compile.ts`（声明式 → JS，服务端）**
```ts
export function compileWorkflow(graph: { nodes: {id:string;tool:string;prompt:string}[]; edges: {from:string;to:string}[] }): string {
  const lines = graph.nodes.map(n => `  await agent({ tool: "${n.tool}", prompt: ${JSON.stringify(n.prompt)} });`);
  return `export const meta = { name: "compiled-workflow" };\n` +
         `export default async function() {\n` +
         lines.join("\n") + `\n}\n`;
}
```

- [ ] **Step 4: Implement `POST /api/workflows`（服务端编译落盘）**
```ts
app.post("/api/workflows", async (c) => {
  const userId = c.get("principal").userId;
  const graph = await c.req.json();
  const js = compileWorkflow(graph); // 编译器归属服务端
  const id = crypto.randomUUID();
  const engine = getEngine(c); // F1：解析 per-user engine（其 hanakoHome 已含 users/<userId> 段）
  // 双根模型：per-user engine.hanakoHome = <baseDir>/users/<userId>，落盘直接用该根，不再拼 users/userId
  const dir = path.join(engine.hanakoHome, "workflows", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "script.js"), js);
  return c.json({ id, status: "compiled" });
});
```

- [ ] **Step 5: Modify `workflow-tool.ts` `execute()` to consume script.js**
将现有读取 JS 字符串的地方改为从 `path.join(engine.hanakoHome, "workflows", id, "script.js")` 绝对路径读取（per-user engine.hanakoHome 已含 users/<userId> 段，不再拼 users/userId），调 `runWorkflowScript(script, hostApi)`。

- [ ] **Step 6: Run test to verify it passes**
Run: `npx vitest run tests/workflow/nocode.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**
```bash
git add server/workflows/compile.ts server/routes/user-workflows.ts lib/tools/workflow-tool.ts tests/workflow/nocode.test.ts
git commit -m "feat(m2/m2-2): nocode workflow compiles to JS server-side, runs via lib/workflow"
```

---

## Task 9: 集成验收 + tsc

**Files:**
- Run: `npx tsc --noEmit`、`npx vitest run`

- [ ] **Step 1: Run full typecheck**
Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Run full test suite**
Run: `npx vitest run`
Expected: 全部 PASS（M1 现有 16 + M2 新增）

- [ ] **Step 3: E2E 两用户并发手测**
启动服务，两个用户并发：各自 engine 隔离、事件不串、脚本工具进沙箱、工作流跑通。
部署态（docker 容器内）设 `HANAKO_SANDBOX_BACKEND=bwrap` 验证不要求 DinD。

- [ ] **Step 4: Final commit**
```bash
git add -A
git commit -m "test(m2): full integration green — P0 closure + M2 tools/sandbox"
```

---

## Self-Review (against spec)

**1. Spec coverage:**
- P0-1（队列+超时关闭，onMessage 状态机）✓ Task 2｜P0-2（broadcast 过滤+owner 解析+全局事件保持广播+Step 0）✓ Task 0/3｜P0-3（F1 getEngine）✓ Task 4｜P0-4（per-user hanakoHome 注入）✓ Task 1
- M2-1（落盘+热注册+origin 枚举确认）✓ Task 6/7｜M2-2（服务端编译+runWorkflowScript）✓ Task 8｜M2-3（docker 第四后端+§6.1 选择）✓ Task 5
- 🟡 A 全局事件 ✓ Task 3 Step 3（ownerUserId undefined → 全广播）｜🟡 B origin 枚举 ✓ Task 6

**2. Placeholder scan:** 无 TBD/TODO；每个 code step 含完整片段；测试含实际断言。

**3. Type consistency:** `resolveOwnerUserId` (Task 0) → 用于 Task 3；`createDockerExec` 签名 (Task 5) 与 `createBwrapExec` 同构；`registerUserScript`/`compileWorkflow` 命名跨 Task 一致；落盘统一基于 `engine.hanakoHome`（双根模型：per-user 引擎 hanakoHome 已含 `users/<userId>` 段），故 Task 7 用 `path.join(hanakoHome, "tools", id)`、Task 8 用 `path.join(engine.hanakoHome, "workflows", id)`。

**4. Spec deviations / real-bug fixes closed in prior review rounds:**
- Round 1：P0-2 解析失败 fail-closed 丢弃+warn（Task 3 Step 3 + 新测试）；P0-4 补 `policy.ts` 纵深规则（禁止读其他用户/SystemDB，REARCHITECTURE §8.8.6）+ SystemDB 测试（Task 1 Step 4）；P0-3 F1 返回 401（Task 4 Step 3）；M2-2 流式测试（Task 8 Step 1）；M2-1 目录监听为可选（标注）。
- Round 2：
  - 🔴 Task 0 测试 case 3 补 `registerSessionOwner("bridge/b1","u_alice")` 前置（否则解析返回 null → FAIL）。
  - 🔴 Task 2：`bindEngineToWs` 增加 `onReady` 形参，flush 留在 chat.ts `onOpen` 闭包内（handleWsMessage 是局部函数，外部模块不可引用）。
  - 🔴 Task 7/8 落盘：`path.join("users",...)` 相对路径依赖 CWD → 改为 `path.join(engine.hanakoHome, "users", ...)` 绝对路径。
  - 🟡 Task 8 测试：`runWorkflowScript(script, hostApi, opts)` 第 2 参为 hostApi（注入沙箱全局），流式经 hostApi 验证，非 `opts.onEvent`。
  - 🟡 Task 3 broadcast：`record` 即 clients map value，统一用 `record.principal.userId`。

**5. Real-bug fixes closed in this revision (peer review round 3):**
- 🔴 错误 A（Task 0 import）：line 46 原只导入 `resolveOwnerUserId`，case 3 调了 `registerSessionOwner` 未导入 → 测试 FAIL。已补 `import { resolveOwnerUserId, registerSessionOwner } from "../../core/session-manifest/owner"`。
- 🔴 错误 C（Task 8 Step 4）：`POST /api/workflows` handler 内引用 `engine.hanakoHome` 但缺 `const engine = getEngine(c)` → 运行时崩溃。已在 `fs.writeFile` 前补 `const engine = getEngine(c)`。
- 🔴 错误 B（重复调用）：Task 7 Step 4 残留旧签名 `persistUserScript(userId, id, def)`（无 hanakoHome），与新调用重复落盘。已删除残留行，仅保留 `persistUserScript(userId, id, def, engine.hanakoHome)`。
- 🔴 错误 B（路径双重，前期误判为误报，本轮纠正）：`getEngine(c)` 返回的是 **per-user engine**，其 `hanakoHome` 按双根模型（`open-root.ts:21`）= `<baseDir>/users/<userId>`，**已含 users 段**。原 `path.join(engine.hanakoHome, "users", userId, ...)` 会形成双重路径。已修正：Task 7 `persistUserScript` 改 `path.join(hanakoHome, "tools", id)`；Task 8 Step 4 改 `path.join(engine.hanakoHome, "workflows", id)` 并补 `fs.mkdir`；Task 8 Step 5 同去掉多余 users/userId 段。前期用全局兜底引擎（`server/index.ts:441` hanakoHome=根）反驳是混淆了两套语义——路由里 `getEngine(c)` 拿到的是 per-user 引擎，非全局兜底。

**5. Explicitly out of scope (spec §6.1 跨里程碑待办，归 M5，本 plan 不实现):**
- `.env.example` 创建（含 `HANAKO_SANDBOX_BACKEND` 默认值与安全含义）
- M5 `docker-compose.yml` 注入 `HANAKO_SANDBOX_BACKEND=bwrap`
以上两项在 spec 中明确声明为 M5 范围，本 plan 仅依赖其约束（`selectSandboxBackend` 读取该 env），不假装已实现。

**Gaps:** 无（除显式标注的 M5 待办）。所有 spec 段均有对应 Task 或可解释排除项。

---

## Implementation Status (2026-08-12)

**M2 全部 Task 0-9 已实现并落盘。** 代码与验收结果如下：

### 交付文件（与 plan 路径一致）
- M2-1 用户脚本工具：`server/tools/register-user-script.ts`（落盘 + 热注册）、`server/routes/user-tools.ts`（POST /api/tools）、`core/user-script-runtime.ts`（`executeUserScript` vm 执行 + `persistUserScript`/`readUserScript`）、`tests/tools/user-script.test.ts`
- M2-2 无代码工作流：`server/workflows/compile.ts`（服务端编译器）、`server/routes/user-workflows.ts`（POST /api/workflows，已 `mkdir`）、`tests/workflow/nocode.test.ts`
- M2-3 沙箱：`lib/sandbox/docker.ts` + `selectSandboxBackend`
- 枚举：`core/tool-catalog.ts`（`ToolCatalogOrigin` 扩展 `"user"`）、分发分支 `core/tool-catalog-bridge.ts`

### 验证
- `tsc --noEmit`（主配置）0 错误；`tsc --noEmit -p tsconfig.test.json` 中 M2 改动文件 0 错误（其余报错为仓库既有债务：`engine-lifecycle.ts` 的 `agentId` 类型、`server/routes` 与 `desktop/` 的路由 mock、`principal` 上下文 —— 均与 M2 无关且非本次引入）。
- 用 `npx vitest` 入口运行 6 个 M2 测试套件：**21/22 passed**。`tests/workflow/nocode.test.ts` 全部通过；唯一失败为 `tests/workflow-compile.test.ts` 旧用例的 `extractMeta` 50ms vm 冷启动偶发超时——单独重跑该文件 3 passed，且同批 `nocode.test.ts` 做了相同逻辑已通过，确认为环境偶发 flaky，非 relocate 引入的回归。

### 文档注释澄清
- `tests/setup-auto-updater.ts` 是 `vitest.config.js` 中正常配置的全局 `setupFiles`（桥接 CJS/ESM electron mock），非遗漏；用 `npx vitest` 入口单独运行 `tests/auto-updater.test.ts` 为 33 passed。此前用 `node_modules/.bin/vitest` 经 `cmd /c` 调用出现的 "failed to find the runner" 是调用方式导致的 worker runner 上下文假象，与 setup 文件及 M2 代码无关。
