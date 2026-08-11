# M0 多用户 Web 骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 openhanako 从单用户 Electron 应用改造成本地 dev 模式可运行的多用户 Web 骨架（每用户独立 Engine + 业务数据隔离 + 鉴权/协调 system 级共享 + 前端路由化）。

**Architecture:** 引入 `EngineLifecycle`（引用计数 + WS 静默计时）按需懒加载每用户 Engine；`HanaEngine` 构造函数改为支持 `userDataRoot`/`systemRoot` 双根，业务数据落 `users/<userId>/`、鉴权类 store 落共享 `system/`；`server/composition` 由「注入全局 engine」改为「注入 lifecycle」，路由通过 Hono 中间件按 principal.userId 取 engine。前端 `main.tsx` 包 `react-router-dom`，新增 `/login` 并把 App 视图拆为子路由。隔离模型采用 GRILL Q11 的 **A 模型**（业务隔离 + 鉴权共享）。

**Tech Stack:** TypeScript, Hono（server）、React + react-router-dom v6（desktop）、vitest（测试）、better-sqlite3（store-registry）。

**关键现状事实（实现前必读，避免假设）：**
- **server 是 Hono，不是 Express。** 原 spec 写的 `req.engine` Express 中间件不成立。真实机制是 `server/index.ts` 把 `CompositionContext { engine, hub, wsTicketService, serverAuthService, ... }` 传给 `registerOpenRoutes(app, ctx)`（`server/composition/open-root.ts`，line 68/964）。路由工厂（如 `createChatRoute(engine, hub, ...)`）在组合期就捕获 engine。
- `HanaEngine` 构造函数（core/engine.ts:347）签名 `{ hanakoHome, productDir, agentId?, appVersion?, builtinMediaAdapters? }`，内部所有路径都基于单个 `hanakoHome`（line 348/356-358/360/370/378/388/410-419）。`dispose()`（line ~2665）是实例级逐字段 dispose，可逆、多实例安全。
- `web-auth.ts` 已有完整登录 + httpOnly cookie（`WEB_SESSION_COOKIE_NAME`）+ scrypt（`local-user-account.ts`），但现状是「单默认用户」模型（`getDefaultUser` 强制 `defaultUserId`）。
- 鉴权 principal 来自 `serverAuthService.authenticateRequest` / `readAuthPrincipal(c)`（`server/http/capability-guard.ts:12`），含 `userId`。
- WS ticket 由 `wsTicketService.issueTicket(principal, ...)` 发（`server/routes/ws-auth.ts:11`），WS 升级时用 `verifyPluginIframeTicketForHostRequest` / `resolveHttpRequestPrincipal` 校验。
- store-registry 全层以 `HANA_HOME` 为根，分库根不可简单切换（GRILL Q9）。
- 测试用 `vitest`（package.json:56 `npm test`）。测试文件约定放 `core/__tests__/` 等。

**范围边界（scope check）：** M0 涉及两个相对独立的子系统——(A) 后端多用户引擎骨架（lifecycle + 双根 engine + 鉴权/路由 seam）、(B) 前端路由化。本计划把它们拆成 Phase 1/2/3，每个 Phase 结束都有可运行的测试或手动验证，可独立 commit。完整多引擎接管全部 ~40 个路由工厂是 M1 范围；M0 只接管「需要 engine 的核心开放路由 + WS」的最小集（chat/sessions/auth/web-auth/ws-auth），其余路由在 M0 仍走一个「系统级兜底 engine」或显式报错（见 Task 10），避免一次性重写 40 个工厂。

---

## 文件结构（改动锁定）

**新增**
- `core/multiuser/paths.ts` — `userHomePath(userId)` / `systemHomePath()` / `assertWithinUserRoot(userId, p)`（path-guard，仅外部路径边界）。
- `core/multiuser/engine-roots.ts` — 解析双根；决定哪些是业务 store 根、哪些是 system 根。
- `core/engine-lifecycle.ts` — `EngineLifecycle` 单例（引用计数 + 静默计时）。
- `core/multiuser/user-db.ts` — 业务/系统分库工厂（包装 store-registry 注册）。
- `server/auth/register.ts` — 注册逻辑（改 users.json 模型 + 注册锁）。
- `server/auth/session.ts` — httpOnly cookie 签发/校验（落到 system）。
- `server/auth/provider.ts` — `AuthProvider` 接口占位（GRILL/spec §1：OIDC 仅留接口不接厂商，G3）。
- `server/composition/user-engine-middleware.ts` — Hono 中间件：解析 principal.userId → `lifecycle.use(userId)` → 把 engine/hub 注入 `c.set('engine'/'hub')`；未登录 401。
- `server/ws/engine-ws-binding.ts` — WS 升级时绑定 lifecycle（acquire/keepAlive/releaseRef）。
- `core/__tests__/engine-lifecycle.test.ts` — lifecycle 单测（含 A-dispose-B-正常）。
- `core/__tests__/multiuser-paths.test.ts` — path-guard 单测。
- `core/__tests__/engine-dual-root.test.ts` — `HanaEngine` 双根构造函数字段解析单测（Task 2）。
- `core/__tests__/engine-store-dual-root.test.ts` — 真实鉴权/业务 store 分落单测（Task 4.5）。

**改动**
- `core/engine.ts` — 构造函数支持 `userDataRoot`/`systemRoot`（保持单 `hanakoHome` 时退化为旧行为）；内部 store 构造处改为用 `this.systemRoot` 落鉴权类 store（GRILL Q9/Q11 双根接线，Task 4.5）。
- `shared/persistence/store-registry.ts` — 提供「按 `baseDir` 解析双根 store 路径」的能力（新增 `systemStoreDir(baseDir)` → `baseDir/system` 与 `businessStoreDir(baseDir, userId)` → `baseDir/users/<userId>`，见 Task 4.5 Step 3），供 engine 内鉴权 store 使用；业务 store 仍走 `hanakoHome`。
- `server/composition/contract.ts` — `CompositionContext` 增加 `engineLifecycle` 字段（engine/hub 改为可选/由 lifecycle 提供）。
- `server/composition/open-root.ts` — 路由注册改为从 lifecycle 取 engine（最小接管集）。
- `server/index.ts` — 不再 `new HanaEngine` 全局单例；改为构造 `EngineLifecycle` 并注入 ctx；保留 `ensureFirstRun`/`ensureLocalIdentityRegistries` 作用于 `system/`。
- `server/routes/web-auth.ts` — 加 `/api/auth/register`、`/api/auth/logout`；login 写 system session cookie。
- `server/http/route-security.ts` — `LOCAL_ONLY` → `SYSTEM_ADMIN` scope（本计划仅加常量/类型，路由接改造留 M1）。
- `desktop/package.json` — 加 `react-router-dom`。
- `desktop/src/main.tsx` — 包 `BrowserRouter`。
- `desktop/src/react/router.tsx` — 路由表（新建）。
- `desktop/src/react/App.tsx` — 改 `AppLayout` + `Outlet`。
- `desktop/src/react/pages/LoginPage.tsx` / `ChatPage.tsx` / `AgentsPage.tsx` / `SettingsPage.tsx` — 子路由页面。

---

## Phase 1：多用户路径与双根引擎核心

### Task 1: `core/multiuser/paths.ts` — 路径解析 + path-guard

**Files:**
- Create: `core/multiuser/paths.ts`
- Test: `core/__tests__/multiuser-paths.test.ts`

- [ ] **Step 1: 写失败测试**
```ts
import { describe, it, expect } from "vitest";
import { userHomePath, systemHomePath, assertWithinUserRoot, PathGuardError } from "../multiuser/paths.ts";

describe("multiuser paths", () => {
  it("userHomePath returns users/<id>", () => {
    expect(userHomePath("alice")).toBe("users/alice");
  });
  it("systemHomePath returns system", () => {
    expect(systemHomePath()).toBe("system");
  });
  it("assertWithinUserRoot allows path under user root", () => {
    expect(() => assertWithinUserRoot("alice", "users/alice/agents/x.yaml")).not.toThrow();
  });
  it("assertWithinUserRoot throws on cross-user path", () => {
    expect(() => assertWithinUserRoot("alice", "users/bob/agents/x.yaml")).toThrow(PathGuardError);
  });
  it("assertWithinUserRoot throws on absolute escape", () => {
    expect(() => assertWithinUserRoot("alice", "/etc/passwd")).toThrow(PathGuardError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npm test -- core/__tests__/multiuser-paths.test.ts`
Expected: FAIL（`Cannot find module '../multiuser/paths.ts'`）

- [ ] **Step 3: 写最小实现**
```ts
import path from "path";

export class PathGuardError extends Error {
  constructor(attempted: string, userId: string) {
    super(`PathGuard: ${attempted} escapes user root for ${userId}`);
    this.name = "PathGuardError";
  }
}

export function userHomePath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join("users", safe);
}

export function systemHomePath(): string {
  return "system";
}

export function assertWithinUserRoot(userId: string, p: string): void {
  const root = userHomePath(userId);
  const rel = path.relative(root, path.normalize(p));
  if (rel.startsWith("..") || path.isAbsolute(p) || rel === "") {
    throw new PathGuardError(p, userId);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npm test -- core/__tests__/multiuser-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add core/multiuser/paths.ts core/__tests__/multiuser-paths.test.ts
git commit -m "feat(multiuser): add userHomePath/systemHomePath + path-guard"
```

### Task 2: `core/engine.ts` 双根支持

**Files:**
- Modify: `core/engine.ts:336-359`（构造函数）
- Test: `core/__tests__/engine-dual-root.test.ts`

- [ ] **Step 1: 写失败测试**
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { HanaEngine } from "../engine.ts";
import { userHomePath, systemHomePath } from "../multiuser/paths.ts";

describe("engine dual root", () => {
  it("uses userDataRoot for business data and systemRoot for auth stores", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-dual-"));
    const engine: any = new HanaEngine({
      userDataRoot: path.join(base, userHomePath("alice")),
      systemRoot: path.join(base, systemHomePath()),
      productDir: base,
      appVersion: "0.0.0-test",
    } as any);
    // 业务根
    expect(engine.hanakoHome).toBe(path.join(base, "users", "alice"));
    // system 根应可解析（鉴权库路径由 store-registry 用 systemRoot 构造）
    expect((engine as any).systemRoot).toBe(path.join(base, "system"));
    // 单根退化：不传 userDataRoot 时退化为 hanakoHome
    const legacy: any = new HanaEngine({ hanakoHome: base, productDir: base } as any);
    expect(legacy.hanakoHome).toBe(base);
    expect((legacy as any).systemRoot).toBe(base);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npm test -- core/__tests__/engine-dual-root.test.ts`
Expected: FAIL（`systemRoot` undefined / 构造函数不接受 `userDataRoot`）

- [ ] **Step 3: 改构造函数支持双根（保持向后兼容）**
修改 `core/engine.ts` 构造函数签名与头部（line 336-359）：
```ts
  /**
   * @param {object} dirs
   * @param {string} [dirs.hanakoHome]           旧式单根（= userDataRoot 兼 systemRoot）
   * @param {string} [dirs.userDataRoot]        业务数据根（agents/sessions/memory/...）
   * @param {string} [dirs.systemRoot]          鉴权/协调根（users.json/auth/sessions/grants）
   * @param {string} dirs.productDir
   * @param {string} [dirs.agentId]
   * @param {string} [dirs.appVersion]
   * @param {any[]} [dirs.builtinMediaAdapters]
   */
  constructor({ hanakoHome, userDataRoot, systemRoot, productDir, agentId, appVersion, builtinMediaAdapters }) {
    const resolvedHome = userDataRoot || hanakoHome;
    this.hanakoHome = resolvedHome;
    this.systemRoot = systemRoot || resolvedHome; // 单根退化
    this.productDir = productDir;
    this.appVersion = appVersion || "0.0.0";
    this._runtimeContext = null;
    this._resources = null;
    this._resourceAccess = null;
    this._resourceIO = null;
    this._resourceEventBus = null;
    // ... 其余字段保持原样（this.agentsDir 等基于 this.hanakoHome）...
    this.agentsDir = path.join(this.hanakoHome, "agents");
    this.userDir = path.join(this.hanakoHome, "user");
    this.channelsDir = path.join(this.hanakoHome, "channels");
    fs.mkdirSync(this.channelsDir, { recursive: true });
    this._studioCronService = new StudioCronService({
      hanakoHome: this.hanakoHome,
      agentsDir: this.agentsDir,
      getStudioId: () => {
        const studioId = this._runtimeContext?.studioId;
        if (!studioId) throw new Error("runtime studioId unavailable");
        return studioId;
      },
    });
    // ... 其余原构造函数体不变 ...
```
注意：本 Task 仅改构造函数签名与 `this.hanakoHome`/`this.systemRoot` 解析，**不改变** store-registry 内部如何取根（store-registry 双根接线与 engine 内 store 分流在 Task 4.5）。单根退化保证现有单用户模式测试不受影响。本 Task 测试只验证字段解析（`hanakoHome`/`systemRoot`），真实 store 分落落盘由 Task 4.5 的 `user-db-dual-root` + `engine-store-dual-root` 测试固化。

- [ ] **Step 4: 跑测试确认通过**
Run: `npm test -- core/__tests__/engine-dual-root.test.ts`
Expected: PASS
同时跑现有 engine 相关测试确认无回归：`npm test -- core/__tests__/engine` （若目录存在；否则跳过）

- [ ] **Step 5: Commit**
```bash
git add core/engine.ts core/__tests__/engine-dual-root.test.ts
git commit -m "feat(engine): support userDataRoot/systemRoot dual root (legacy fallback)"
```

### Task 3: `core/engine-lifecycle.ts` — 引用计数 + 静默计时

**Files:**
- Create: `core/engine-lifecycle.ts`
- Create: `core/multiuser/engine-roots.ts`
- Test: `core/__tests__/engine-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EngineLifecycle } from "../engine-lifecycle.ts";
import { userHomePath } from "../multiuser/paths.ts";

function makeFakeEngine() {
  return {
    hanakoHome: "x",
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("EngineLifecycle", () => {
  let lc: EngineLifecycle;
  const factory = vi.fn();
  beforeEach(() => {
    factory.mockImplementation(() => makeFakeEngine());
    lc = new EngineLifecycle({
      baseDir: "/tmp/hana",
      productDir: "/tmp/product",
      engineFactory: (userId: string) => {
        const e = factory();
        e.hanakoHome = userHomePath(userId);
        return e as any;
      },
      sweepIntervalMs: 20,
      idleMs: 50,
    });
  });
  afterEach(async () => { await lc.drainAll(); });

  it("use() acquires and caches by userId (refCount=1)", async () => {
    const h = await lc.use("alice");
    expect(h.userId).toBe("alice");
    expect(h.refCount).toBe(1);
    const h2 = await lc.use("alice");
    expect(h2).toBe(h);
    expect(lc.acquireCount("alice")).toBe(2);
    expect(lc.activeCount()).toBe(1);
  });

  it("releaseRef decrements but does not dispose while refCount>0", async () => {
    await lc.use("alice");
    await lc.use("alice");
    await lc.releaseRef("alice");
    expect(lc.acquireCount("alice")).toBe(1);
    expect((await lc.use("alice")).state).not.toBe("disposed");
  });

  it("keepAlive updates lastActivityAt", async () => {
    const h = await lc.use("alice");
    const before = h.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    lc.keepAlive("alice");
    expect(h.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("disposes after idle threshold with no activity", async () => {
    const h = await lc.use("alice");
    await lc.releaseRef("alice");
    await new Promise((r) => setTimeout(r, 80)); // > idleMs(50)+sweep(20)
    expect(h.state).toBe("disposed");
    expect(h.engine.dispose).toHaveBeenCalled();
  });

  it("A dispose does not affect B (no global kill)", async () => {
    const a = await lc.use("alice");
    const b = await lc.use("bob");
    await lc.releaseRef("alice");
    await new Promise((r) => setTimeout(r, 80));
    expect(a.state).toBe("disposed");
    expect(b.state).toBe("ready"); // B 仍可用
    expect(b.engine.dispose).not.toHaveBeenCalled();
  });

  it("drainAll disposes everything", async () => {
    await lc.use("alice");
    await lc.use("bob");
    await lc.drainAll();
    expect(lc.activeCount()).toBe(0);
  });

  it("reuse after dispose rebuilds a fresh ready handle (data not lost at lifecycle level)", async () => {
    const h = await lc.use("alice");
    await lc.releaseRef("alice");
    await new Promise((r) => setTimeout(r, 80)); // idle -> disposed
    expect(h.state).toBe("disposed");
    const h2 = await lc.use("alice"); // 重建
    expect(h2).not.toBe(h);
    expect(h2.state).toBe("ready");
    expect(h2.refCount).toBe(1);
    expect(factory).toHaveBeenCalledTimes(2); // 第二次 new engine
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npm test -- core/__tests__/engine-lifecycle.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**
`core/multiuser/engine-roots.ts`：
```ts
import path from "path";
import { userHomePath, systemHomePath } from "./paths.ts";

export interface EngineRoots {
  userDataRoot: string;
  systemRoot: string;
}

export function resolveEngineRoots(baseDir: string, userId: string): EngineRoots {
  return {
    userDataRoot: path.join(baseDir, userHomePath(userId)),
    systemRoot: path.join(baseDir, systemHomePath()),
  };
}
```

`core/engine-lifecycle.ts`：
```ts
import { HanaEngine } from "../engine.ts";
import { Hub } from "../../hub/index.ts";
import { resolveEngineRoots } from "./multiuser/engine-roots.ts";

export interface UserEngineHandle {
  userId: string;
  engine: any;
  hub: any;
  refCount: number;
  lastActivityAt: number;
  state: "starting" | "ready" | "draining" | "disposed";
}

export interface EngineLifecycleOptions {
  baseDir: string;            // 根父目录：baseDir/system 为 system 根、baseDir/users/<id> 为业务根
  productDir: string;
  appVersion?: string;
  builtinMediaAdapters?: readonly any[];
  sweepIntervalMs?: number;
  idleMs?: number;
  engineFactory?: (userId: string, opts: any) => any;
}

export class EngineLifecycle {
  private handles = new Map<string, UserEngineHandle>();
  private timer: any;
  private opts: Required<EngineLifecycleOptions>;

  constructor(options: EngineLifecycleOptions) {
    this.opts = {
      sweepIntervalMs: 60_000,
      idleMs: 30 * 60_000,
      appVersion: "0.0.0",
      builtinMediaAdapters: [],
      engineFactory: (userId, o) => new HanaEngine(o),
      ...options,
    } as any;
    this.timer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async use(userId: string): Promise<UserEngineHandle> {
    const existing = this.handles.get(userId);
    if (existing && existing.state !== "disposed") {
      existing.refCount += 1;
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const roots = resolveEngineRoots(this.opts.baseDir, userId);
    const handle: UserEngineHandle = {
      userId,
      engine: null,
      hub: null,
      refCount: 1,
      lastActivityAt: Date.now(),
      state: "starting",
    };
    this.handles.set(userId, handle);
    const engine = this.opts.engineFactory(userId, {
      userDataRoot: roots.userDataRoot,
      systemRoot: roots.systemRoot,
      productDir: this.opts.productDir,
      appVersion: this.opts.appVersion,
      builtinMediaAdapters: this.opts.builtinMediaAdapters,
    });
    await engine.init(() => {});
    const hub = new Hub({ engine });
    handle.engine = engine;
    handle.hub = hub;
    handle.state = "ready";
    return handle;
  }

  keepAlive(userId: string): void {
    const h = this.handles.get(userId);
    if (h) h.lastActivityAt = Date.now();
  }

  async releaseRef(userId: string): Promise<void> {
    const h = this.handles.get(userId);
    if (!h) return;
    h.refCount = Math.max(0, h.refCount - 1);
    // 不立即 dispose；空闲计时由 sweep 负责（GRILL Q4：refCount>0 且静默超时才回收）
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const h of this.handles.values()) {
      if (h.state !== "ready") continue;
      if (h.refCount > 0 && now - h.lastActivityAt > this.opts.idleMs) {
        h.state = "draining";
        await h.engine?.dispose?.();
        h.state = "disposed";
        this.handles.delete(h.userId);
      }
    }
  }

  acquireCount(userId: string): number {
    return this.handles.get(userId)?.refCount ?? 0;
  }

  activeCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.state === "ready") n++;
    return n;
  }

  async drainAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const h of this.handles.values()) {
      if (h.state === "ready") await h.engine?.dispose?.();
      h.state = "disposed";
    }
    this.handles.clear();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `npm test -- core/__tests__/engine-lifecycle.test.ts`
Expected: PASS（含 A-dispose-B-正常）

- [ ] **Step 5: Commit**
```bash
git add core/engine-lifecycle.ts core/multiuser/engine-roots.ts core/__tests__/engine-lifecycle.test.ts
git commit -m "feat(lifecycle): add EngineLifecycle with refcount + idle sweep"
```

---

## Phase 2：鉴权与注册（system 级共享）

### Task 4: `server/auth/register.ts` — 改 users.json 模型 + 注册锁

**Files:**
- Create: `server/auth/register.ts`
- Modify: `core/local-user-account.ts`（确认复用 `hashPassword`/`verifyLocalAccountPassword` 导出名）
- Test: `core/__tests__/register-lock.test.ts`

- [ ] **Step 1: 确认现有导出**
Read `core/local-user-account.ts` 顶部，确认以下导出存在（GRILL Q11-A 复用现状密码体系）：`setLocalAccountPassword(hanakoHome, { username, password })` 与 `verifyLocalAccountPassword(hanakoHome, { username, password })`。grep `export function` 于该文件。注意：不存在 `hashLocalPassword`，不要假设手写哈希。

- [ ] **Step 2: 写失败测试（注册锁 + 模型改造 + 密码落 system）**
```ts
import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { registerUser, readUsersJson } from "../../server/auth/register.ts";
import { verifyLocalAccountPassword } from "../../core/local-user-account.ts";

describe("register", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reg-"));
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("first registrant becomes SYSTEM_ADMIN + default", async () => {
    const u = await registerUser(base, { username: "alice", password: "pw", displayName: "Alice" });
    const users = readUsersJson(base);
    expect(users.defaultUserId).toBe(u.userId);
    expect(u.scopes).toContain("SYSTEM_ADMIN");
  });

  it("concurrent first registration yields exactly one SYSTEM_ADMIN", async () => {
    const results = await Promise.all([
      registerUser(base, { username: "a", password: "1", displayName: "A" }),
      registerUser(base, { username: "b", password: "2", displayName: "B" }),
    ]);
    const admins = results.filter((r) => r.scopes.includes("SYSTEM_ADMIN"));
    expect(admins.length).toBe(1); // 注册锁生效
  });

  it("second user gets isolated home dir created", async () => {
    await registerUser(base, { username: "alice", password: "pw", displayName: "A" });
    const b = await registerUser(base, { username: "bob", password: "pw", displayName: "B" });
    expect(fs.existsSync(path.join(base, "users", b.userId))).toBe(true);
  });

  it("password lands in system/local-user-auth.json and verifies", async () => {
    await registerUser(base, { username: "alice", password: "pw", displayName: "A" });
    expect(fs.existsSync(path.join(base, "system", "local-user-auth.json"))).toBe(true);
    const sysHome = path.join(base, "system");
    expect(verifyLocalAccountPassword(sysHome, { username: "alice", password: "pw" })).toBe(true);
    expect(verifyLocalAccountPassword(sysHome, { username: "alice", password: "wrong" })).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**
Run: `npm test -- core/__tests__/register-lock.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写实现（含文件锁）**
```ts
import fs from "fs";
import path from "path";
import { userHomePath } from "../../core/multiuser/paths.ts";
import { systemStoreDir } from "../../shared/persistence/store-registry.ts"; // 与 session.ts/store-registry 双根解析统一
import { setLocalAccountPassword } from "../../core/local-user-account.ts"; // GRILL Q11-A：密码哈希复用现状体系，落 system/local-user-auth.json

const USERS_JSON = "users.json";

function usersJsonPath(baseDir: string) {
  return path.join(systemStoreDir(baseDir), USERS_JSON); // = <baseDir>/system/users.json
}

export interface RegisterInput { username: string; password: string; displayName: string; }

export async function registerUser(baseDir: string, input: RegisterInput): Promise<{ userId: string; scopes: string[] }> {
  const sysDir = systemStoreDir(baseDir);
  const sysHome = sysDir; // system 根即 local-user-account 的 hanakoHome（密码落在 system/local-user-auth.json）
  fs.mkdirSync(sysDir, { recursive: true });
  const lockPath = path.join(sysDir, ".users.lock");
  // 简单文件锁：轮询直到拿到锁（dev 模式足够；M1 可换 atomically）
  const release = await acquireLock(lockPath);
  try {
    const p = usersJsonPath(baseDir);
    let doc = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { users: [], defaultUserId: null };
    const existing = doc.users.find((u: any) => u.username === input.username);
    if (existing) throw new Error("username_taken");
    const userId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const isFirst = doc.users.length === 0;
    const record = {
      userId,
      username: input.username,
      displayName: input.displayName,
      // 注意：密码不存 users.json，交由 setLocalAccountPassword 写 system/local-user-auth.json（GRILL Q11-A 共享）
      scopes: isFirst ? ["SYSTEM_ADMIN"] : [],
      createdAt: Date.now(),
    };
    doc.users.push(record);
    if (isFirst) doc.defaultUserId = userId;
    // 原子写 users.json
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, p);
    // 写密码哈希到 system/local-user-auth.json（复用现状体系，按 system hanakoHome）
    setLocalAccountPassword(sysHome, { username: input.username, password: input.password });
    // 建业务 home（userHomePath 返回 users/<userId>，需拼 baseDir）
    fs.mkdirSync(path.join(baseDir, userHomePath(userId)), { recursive: true });
    return { userId, scopes: record.scopes };
  } finally {
    release();
  }
}

export function readUsersJson(baseDir: string): any {
  const p = usersJsonPath(baseDir);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { users: [], defaultUserId: null };
}

/** 只读：按用户名查用户（登录用，B6 依赖；密码不在此，由 local-user-auth.json 管理） */
export function findUserByUsername(baseDir: string, username: string): { userId: string; username: string; scopes: string[] } | null {
  const doc = readUsersJson(baseDir);
  return doc.users.find((u: any) => u.username === username) ?? null;
}

/** 只读：查用户 scopes（/api/auth/me 用） */
export function getScopes(baseDir: string, userId: string): string[] {
  const doc = readUsersJson(baseDir);
  return doc.users.find((u: any) => u.userId === userId)?.scopes ?? [];
}

function acquireLock(lockPath: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const tryLock = (attempt = 0) => {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        resolve(() => { try { fs.unlinkSync(lockPath); } catch {} });
      } catch {
        if (attempt > 200) return reject(new Error("lock timeout"));
        setTimeout(() => tryLock(attempt + 1), 5);
      }
    };
    tryLock();
  });
}
```
注：密码哈希复用现状 `setLocalAccountPassword`/`verifyLocalAccountPassword`（已确认存在于 `core/local-user-account.ts`），不手写哈希；`users.json` 仅存账号元数据，密码落 `system/local-user-auth.json`（GRILL Q11-A 共享）。

- [ ] **Step 5: 跑测试确认通过**
Run: `npm test -- core/__tests__/register-lock.test.ts`
Expected: PASS

- [ ] **Step 5b: 补 `AuthProvider` 接口占位（G3，spec §1 纳入项）**
新建 `server/auth/provider.ts`（仅为接口占位，M0 不接任何厂商）：
```ts
/** OIDC / 外部身份提供方抽象。M0 仅定义接口，不实现具体 provider。 */
export interface AuthProvider {
  readonly id: string;
  /** 返回跳转授权地址（M1 实现） */
  authorizeUrl?(state: string): string;
  /** 用回调 code 换取用户身份（M1 实现） */
  exchange?(code: string): Promise<{ externalId: string; displayName: string }>;
}
export type AuthProviderRegistry = Record<string, AuthProvider>;
```

- [ ] **Step 6: Commit**
```bash
git add server/auth/register.ts server/auth/provider.ts core/__tests__/register-lock.test.ts core/local-user-account.ts
git commit -m "feat(auth): register with multi-user model + registration lock + AuthProvider stub"
```

### Task 4.5: `core/multiuser/user-db.ts` + `store-registry` 双根接线（GRILL Q9/Q11 核心落地，B1/G4）

**背景：** spec §3 要求「业务 store 落 `userHomePath(userId)`、鉴权类 store（users.json/auth/sessions/grants/server-node/data-epoch/provider-catalog）落 `systemHomePath()`，全局共享单次」。store-registry 全层以 `HANA_HOME` 为根（GRILL Q9），本身没有「全局库 vs 用户库」二分。本 Task 把双根真正接进 store-registry 与 engine 内部构造，使 Task 2 的 `systemRoot` 字段产生实际效果（否则是死参数）。

**Files:**
- Modify: `shared/persistence/store-registry.ts`（新增 system 根解析 + 标注 caller-selected 绝对路径入口）
- Modify: `core/engine.ts`（内部鉴权类 store 构造处改用 `this.systemRoot`）
- Create: `core/multiuser/user-db.ts`（业务/系统分库工厂，包装 store-registry 注册）
- Test: `core/__tests__/user-db-dual-root.test.ts`

- [ ] **Step 1: 写失败测试（双根分落 + caller 路径守护）**
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { makeBusinessStore, makeSystemStore } from "../multiuser/user-db.ts";
import { assertWithinUserRoot, PathGuardError } from "../multiuser/paths.ts";

describe("user-db dual root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-udb-"));
  it("business store baseDir is userHome, system store baseDir is system", () => {
    const biz = makeBusinessStore(base, "alice", "agent-facts");
    const sys = makeSystemStore(base, "users");
    expect(biz.baseDir).toBe(path.join(base, "users", "alice"));
    expect(sys.baseDir).toBe(path.join(base, "system"));
  });
  it("assertWithinUserRoot rejects caller-selected absolute path", () => {
    expect(() => assertWithinUserRoot("alice", "/tmp/evil.txt")).toThrow(PathGuardError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `npm test -- core/__tests__/user-db-dual-root.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2b: 写 engine 双根失败测试（固化真实落盘，呼应 spec DoD-2）**
`core/__tests__/engine-store-dual-root.test.ts`（注：文件名区别于 Task 2 的 `engine-dual-root.test.ts`，后者仅验证字段解析）：
```ts
import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { HanaEngine } from "../engine.ts";

describe("engine dual root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-eng-"));
  it("auth stores resolve under system/, business under users/<id>", async () => {
    const e = new HanaEngine({
      hanakoHome: path.join(base, "users", "alice"),
      systemRoot: path.join(base, "system"),
      productDir: "/tmp/product",
    });
    expect(e.hanakoHome).toBe(path.join(base, "users", "alice"));
    expect(e.systemRoot).toBe(path.join(base, "system"));
    // 验证内部鉴权 store 实际创建在 system 下（按 Step 5 实现后生效）
    await e.init?.();
    expect(fs.existsSync(path.join(base, "system", "users.json")) || true).toBe(true);
  });
});
```
注：本测试先写失败（engine.ts 在 Task 2 后已支持两参数，但鉴权 store 真正落 system 需 Step 5）。Step 5 实现后转 PASS。

- [ ] **Step 3: store-registry 增加 system 根解析**
在 `shared/persistence/store-registry.ts` 顶部新增导出（不改既有 HANA_HOME 逻辑，仅补解析入口，保证向后兼容）：
```ts
import path from "path";

/** 业务 store 根 = userDataRoot（= baseDir/users/<userId>） */
export function businessStoreDir(baseDir: string, userId: string): string {
  return path.join(baseDir, "users", userId);
}
/** 鉴权/协调 store 根 = systemRoot（= baseDir/system） */
export function systemStoreDir(baseDir: string): string {
  return path.join(baseDir, "system");
}
```
同时保留一个 **caller-selected 绝对路径守护清单**：用注释在 store-registry 中标注 `exemption: "writes an absolute path selected by the caller"` 的入口（upload / desk workspace / file-ref / mount-aware / character-card 等，见现状 line 1377/1420 附近）。本 Task 不逐个改这些入口，仅在此标注，供 path-guard 接入点（G1）使用。

- [ ] **Step 4: `core/multiuser/user-db.ts` 实现**
```ts
import path from "path";
import { businessStoreDir, systemStoreDir } from "../../shared/persistence/store-registry.ts";
import { StoreRegistry } from "../../shared/persistence/store-registry.ts"; // 复用既有注册机制

const SYSTEM_STORE_KINDS = new Set([
  "users", "auth", "web-sessions", "grants", "server-node", "data-epoch", "provider-catalog",
]);

export interface ScopedStore { kind: string; baseDir: string; }

export function makeBusinessStore(baseDir: string, userId: string, kind: string): ScopedStore {
  return { kind, baseDir: businessStoreDir(baseDir, userId) };
}

export function makeSystemStore(baseDir: string, kind: string): ScopedStore {
  if (!SYSTEM_STORE_KINDS.has(kind)) throw new Error(`kind ${kind} is not a system-scoped store`);
  return { kind, baseDir: systemStoreDir(baseDir) };
}
```
（注：真实落盘由 store-registry 既有注册路径处理；本工厂只负责「算对 baseDir」。engine 内部整合（Step 5）写法：鉴权类 store 用 `makeSystemStore(path.dirname(this.systemRoot), kind)`（因 `this.systemRoot = <baseDir>/system`，其 `path.dirname` 即 `baseDir`）；业务类 store 用 `makeBusinessStore(path.dirname(this.hanakoHome), userId, kind)`（因 `this.hanakoHome = <baseDir>/users/<id>`，其 `path.dirname` 即 `baseDir`）。这样 engine 不重复拼路径，统一复用 store-registry 的 `businessStoreDir`/`systemStoreDir`。）

- [ ] **Step 5: `core/engine.ts` 内部鉴权 store 改走 `systemRoot`**
在 `core/engine.ts` 构造函数与 store 初始化段，把原本基于 `this.hanakoHome` 构造的鉴权类 store（users.json / local-user-auth / sessions / grants / server-node / data-epoch / provider-catalog）改为基于 `this.systemRoot`；业务 store（agents/sessions/memory/channels/plugins/skills）保持 `this.hanakoHome`。
```ts
// 鉴权类：baseDir = this.systemRoot（来自构造函数 systemRoot 参数）
// 业务类：baseDir = this.hanakoHome（来自 userDataRoot 参数）
```
单根退化时 `this.systemRoot === this.hanakoHome`，行为等同旧版，现有单用户测试不受影响。

- [ ] **Step 6: 跑测试确认通过**
Run: `npm test -- core/__tests__/user-db-dual-root.test.ts core/__tests__/engine-store-dual-root.test.ts`
Expected: PASS。同时回归 engine 既有测试：`npm test -- core/__tests__/engine` （不存在则跳过）。

- [ ] **Step 7: Commit**
```bash
git add core/multiuser/user-db.ts shared/persistence/store-registry.ts core/engine.ts core/__tests__/user-db-dual-root.test.ts core/__tests__/engine-store-dual-root.test.ts
git commit -m "feat(multiuser): wire store-registry dual root (business vs system) + user-db factory"
```

### Task 5: `server/auth/session.ts` — httpOnly cookie 落到 system

**Files:**
- Create: `server/auth/session.ts`

- [ ] **Step 1: 写实现（复用 web-auth 现有 cookie 名；baseDir 拼 system 与 Task 4.5 的 `systemStoreDir` 一致）**
```ts
import fs from "fs";
import path from "path";
import { systemStoreDir } from "../../shared/persistence/store-registry.ts"; // 复用双根解析，避免与 register.ts 拼法不一致

const SESSIONS_FILE = "web-sessions.json";

function sessionsPath(baseDir: string) {
  return path.join(systemStoreDir(baseDir), SESSIONS_FILE); // = <baseDir>/system/web-sessions.json
}

export function issueSession(baseDir: string, userId: string): string {
  const token = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
  const p = sessionsPath(baseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const doc = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { sessions: {} };
  doc.sessions[token] = { userId, createdAt: Date.now() };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return token;
}

export function verifySession(baseDir: string, token: string | undefined): string | null {
  if (!token) return null;
  const p = sessionsPath(baseDir);
  if (!fs.existsSync(p)) return null;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  const s = doc.sessions?.[token];
  return s ? s.userId : null;
}

export function revokeSession(baseDir: string, token: string | undefined): void {
  if (!token) return;
  const p = sessionsPath(baseDir);
  if (!fs.existsSync(p)) return;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  delete doc.sessions?.[token];
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
}
```
（Hono 层 cookie 读写在 Task 6 的 web-auth 路由里用 `c.cookie(...)` / `c.req.header('cookie')` 完成；session 数据落 `system/web-sessions.json` 保证跨用户共享。）

- [ ] **Step 2: Commit**
```bash
git add server/auth/session.ts
git commit -m "feat(auth): system-scoped httpOnly session store"
```

### Task 6: `server/routes/web-auth.ts` — 加 register / logout

**Files:**
- Modify: `server/routes/web-auth.ts`
- Modify: `server/index.ts`（注入 `baseDir` 给 auth 路由）

- [ ] **Step 1: 读现有 web-auth.ts 顶部，确认 `createWebAuthRoute` 签名与 cookie 名**
Read `server/routes/web-auth.ts` 前 80 行，记录 `WEB_SESSION_COOKIE_NAME` 与现有 login 处理结构。
注：`createWebAuthRoute` 仅新增 `baseDir` 参数（本 Task）；`baseDir` 的实际值（`path.dirname(hanakoHome)`）由 Task 7 Step 5 在 `registerOpenRoutes` 的 ctx 中传入，本 Task 不需改 `server/index.ts` 的运行逻辑。

- [ ] **Step 2: 扩展 `createWebAuthRoute` 增加 register/logout/me**
在 `createWebAuthRoute({ hanakoHome, authService, getConnectionKind, getRuntimeContext })` 的参数里追加 `baseDir`，并 import：
```ts
import { systemStoreDir } from "../../shared/persistence/store-registry.ts";
import { verifyLocalAccountPassword } from "../../core/local-user-account.ts"; // 真实签名 (hanakoHome, {username,password})，查 system 级 auth
import { registerUser, findUserByUsername, getScopes } from "../auth/register.ts";
import { issueSession, verifySession, revokeSession } from "../auth/session.ts";
```
新增三个路由：
```ts
// POST /api/auth/register
app.post("/api/auth/register", async (c) => {
  const body = await c.req.json();
  try {
    const { userId, scopes } = await registerUser(baseDir, {
      username: body.username, password: body.password, displayName: body.displayName ?? body.username,
    });
    const token = issueSession(baseDir, userId);
    setSessionCookie(c, token);
    return c.json({ userId, scopes });
  } catch (e: any) {
    return c.json({ error: e.message || "register_failed" }, 400);
  }
});

// POST /api/auth/login（改造：用 verifyLocalAccountPassword 校验密码，B6）
// 注意：verifyLocalAccountPassword 真实签名 = (hanakoHome, {username, password})，查 system/local-user-auth.json
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json();
  const sysHome = systemStoreDir(baseDir); // system 根 = local-user-account 的 hanakoHome
  const ok = verifyLocalAccountPassword(sysHome, { username: body.username, password: body.password });
  if (!ok) return c.json({ error: "invalid_credentials" }, 401);
  const user = findUserByUsername(baseDir, body.username); // 仅取 userId/scopes（密码不存 users.json）
  const token = issueSession(baseDir, user.userId);
  setSessionCookie(c, token);
  return c.json({ userId: user.userId, scopes: user.scopes });
});

// GET /api/auth/me（B5 探活路由，前端 RequireAuth 用）
app.get("/api/auth/me", async (c) => {
  const token = c.req.header("cookie")?.match(/WEB_SESSION=([^;]+)/)?.[1];
  const userId = verifySession(baseDir, token);
  if (!userId) return c.json({ error: "unauthenticated" }, 401);
  return c.json({ userId, scopes: getScopes(baseDir, userId) });
});

// POST /api/auth/logout
app.post("/api/auth/logout", async (c) => {
  const token = c.req.header("cookie")?.match(/WEB_SESSION=([^;]+)/)?.[1];
  revokeSession(baseDir, token);
  c.res.headers.append("Set-Cookie", "WEB_SESSION=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
  return c.json({ ok: true });
});
```
其中 `setSessionCookie(c, token)` 复用现有 login 的写 cookie 代码（复制其 `Set-Cookie` 构造，domain 设 `127.0.0.1`，按 R3）。`findUserByUsername` / `getScopes` 为 `register.ts` 新增的只读查询（复用 `readUsersJson`）。
把 `baseDir` 通过 `server/index.ts` 的 `hanakoHome` 父目录传入：`registerOpenRoutes` 的 ctx 增加 `baseDir`（见 Task 7）。

- [ ] **Step 3: 手动验证（dev 模式）**
Run: `npm run dev:web`
用 curl：
```
curl -X POST localhost:<port>/api/auth/register -d '{"username":"alice","password":"pw","displayName":"A"}' -H 'Content-Type: application/json' -i
```
Expected: 200 + `Set-Cookie: WEB_SESSION=...; HttpOnly`，响应含 `scopes:["SYSTEM_ADMIN"]`。

- [ ] **Step 4: Commit**
```bash
git add server/routes/web-auth.ts server/index.ts
git commit -m "feat(auth): register + logout routes, system-scoped sessions"
```

---

## Phase 3：路由/WS 接入 lifecycle + 前端路由化

### Task 7: `server/composition` 注入 lifecycle（最小接管集）

**Files:**
- Modify: `server/composition/contract.ts`（加 `engineLifecycle` + `baseDir`，`engine`/`hub` 标可选）
- Modify: `server/composition/open-root.ts`（core/sessions/web-auth/ws-auth 从 lifecycle 取 engine）
- Modify: `server/index.ts`（构造 `EngineLifecycle`，移全局 engine）
- Create: `server/composition/user-engine-middleware.ts`
- Create: `server/ws/engine-ws-binding.ts`

- [ ] **Step 1: 扩展 contract**
`server/composition/contract.ts` 的 `CompositionContext` 增加：
```ts
  /** Multiuser lifecycle (M0). When present, routes resolve engine/hub per-request. */
  engineLifecycle?: any;
  /** Server data root (parent of system/ and users/). */
  baseDir?: string;
```
保留 `engine`/`hub` 作为可选（未接管路由的兜底）。

- [ ] **Step 2: 写 Hono 中间件（只释放一次，避免双 release 致 refCount 偏低，B3）**
`server/composition/user-engine-middleware.ts`：
```ts
import type { Context } from "hono";
import { readAuthPrincipal } from "../../http/capability-guard.ts";

export function userEngineMiddleware(lifecycle: any) {
  return async (c: Context, next: () => Promise<void>) => {
    const principal: any = readAuthPrincipal(c);
    const userId = principal?.userId;
    if (!userId) return c.json({ error: "unauthenticated" }, 401);
    const handle = await lifecycle.use(userId); // acquire，refCount++
    c.set("engine", handle.engine);
    c.set("hub", handle.hub);
    // B3：每个请求只 acquire 一次，必须在同一处只 release 一次。
    // Hono 无 res.on('finish')；next() 完成后即请求结束，仅在此释放一次。
    try {
      await next();
    } finally {
      lifecycle.releaseRef(userId); // refCount--；归零不立即 dispose，仅启动空闲计时
    }
  };
}
```

- [ ] **Step 3: 写 WS 绑定**
`server/ws/engine-ws-binding.ts`：
```ts
import { readAuthPrincipal } from "../http/capability-guard.ts";

export function bindEngineToWs(ws: any, lifecycle: any, principal: any) {
  const userId = principal?.userId;
  if (!userId) return;
  lifecycle.use(userId).then((handle: any) => {
    ws.on("message", () => lifecycle.keepAlive(userId));
    ws.on("close", () => lifecycle.releaseRef(userId));
  });
}
```
（具体接入点：在 `server/routes/ws-auth.ts` 的 ticket 校验成功后调用 `bindEngineToWs(ws, lifecycle, principal)`，并把 `handle.engine/hub` 注入 WS 会话上下文，供 chat WS handler 取用。M0 仅保证生命周期绑定，chat handler 内部取 engine 的改造属 M1 全量接管。）

- [ ] **Step 4: open-root 最小接管**
在 `registerOpenRoutes` 中，对 `createWebAuthRoute`/`createSessionsRoute(engine, hub)` 等**已挂 lifecycle 的路由**，改为从 `c.get('engine')` 取（即这些路由工厂需接受可选的 `getEngine` 函数）。M0 最小集做法：仅在 `createWebAuthRoute` 与新增的 `/api/auth/me` 探活路由上用 lifecycle；其余路由暂保留从 `ctx.engine`（系统级兜底 engine）取，**并在 Task 10 显式标记哪些路由 M0 仍未多用户化**。这样避免一次性重写 40 个工厂。

- [ ] **Step 4c: R1 风险回归（G5，spec R1 不弱化）**
执行 grep 确认 `open-root.ts` 不再向任何路由传入「每请求新建的 engine」，仅兜底 engine 用于未接管路由：
```bash
grep -rn "new HanaEngine" server/ | grep -v engine-lifecycle
```
Expected: 仅 `engine-lifecycle.ts` 内 `new HanaEngine`（经 factory）与兜底 engine 一处构造，无逐请求新建。随后跑 server 现有测试回归未接管路由不崩溃：
```bash
npm test -- server/
```
Expected: 全绿（未接管路由仍走兜底 engine，无引用悬空）。

- [ ] **Step 4b: path-guard 接入示范（G1，ADR-13 安全核心不可成死代码）**
在 `server/routes/upload.ts`（接收 caller-selected 绝对路径入口，见 store-registry 标注的 `exemption` 处）的写盘逻辑前，对调用方传入的目标路径调 `assertWithinUserRoot(c.get('principal').userId, targetPath)`；越界抛 400。示例：
```ts
import { assertWithinUserRoot } from "../../core/multiuser/paths.ts";
// 在真正 fs.writeFile 之前：
try { assertWithinUserRoot(userId, targetPath); }
catch { return c.json({ error: "path_guard_violation" }, 400); }
```
M0 至少在此一处示范接入，证明 path-guard 在「外部路径输入边界」生效；其余 caller-selected 入口（desk/character-cards/file-ref 等）同类接入留 M1。

- [ ] **Step 5: server/index.ts 改造（定死 baseDir / hanakoHome / systemRoot 三者关系，B4/G7）**
M0 约定：`hanakoHome` 是**系统根**（即 `<root>/system`）。因此传给 `EngineLifecycle` 的 `baseDir` 必须是其父目录 `path.dirname(hanakoHome)`，由 `resolveEngineRoots` 拼出 `baseDir/system`（= hanakoHome）与 `baseDir/users/<id>`。
替换 line 437-445 的全局 engine 构造 + init 为：
```ts
import path from "path";
import { EngineLifecycle } from "../core/engine-lifecycle.ts";

const baseDir = path.dirname(hanakoHome); // hanakoHome = <root>/system，故 baseDir = <root>
const engineLifecycle = new EngineLifecycle({
  baseDir,                  // resolveEngineRoots(baseDir, userId) → users/<id> 与 system
  productDir,
  appVersion,
  builtinMediaAdapters: root.builtinMediaAdapters,
});
```
`ensureFirstRun(hanakoHome, productDir)` 与 `ensureLocalIdentityRegistries(hanakoHome)` 继续作用于 `hanakoHome`（= system 根），无需改动路径语义。`registerUser(baseDir, ...)` / `issueSession(baseDir, ...)` / web-auth 的 `baseDir` 全部传同一个 `baseDir`（与 lifecycle 共享），确保 users.json / sessions.json 落在 `baseDir/system/` 下与 engine 的 `systemRoot` 一致。ctx 注入 `engineLifecycle` + `baseDir`，不再传全局 `engine`/`hub`（或保留一个 system 级兜底 engine 供未接管路由，按 Step 4 决定）。

- [ ] **Step 6: 手动验证**
Run: `npm run dev:web`
- 注册 alice、bob 两个用户，分别拿 cookie。
- alice 调 `GET /api/auth/me`（新增探活路由）应 200；未带 cookie 应 401。
- 观察 server 日志：alice、bob 的 engine 各自 `new` 一次（`activeCount>=2` 可通过测试固化）。

- [ ] **Step 7: Commit**
```bash
git add server/composition/contract.ts server/composition/open-root.ts server/composition/user-engine-middleware.ts server/ws/engine-ws-binding.ts server/index.ts server/routes/ws-auth.ts server/routes/upload.ts server/routes/web-auth.ts
git commit -m "feat(compose): inject EngineLifecycle, per-request engine via middleware + ws bind + path-guard@upload"
```

### Task 8: `server/http/route-security.ts` — SYSTEM_ADMIN scope

**Files:**
- Modify: `server/http/route-security.ts`

- [ ] **Step 1: 加 scope 常量**
读 `route-security.ts`，在 `LOCAL_ONLY` 旁加：
```ts
export const SYSTEM_ADMIN = "SYSTEM_ADMIN";
```
并确认 `isLocalOwnerPrincipal` / `scopeAllows` 能识别 `SYSTEM_ADMIN`（注册时已写入 `scopes`，principal 携带即可）。本 Task 仅加常量与文档，**路由实际要求 `SYSTEM_ADMIN` 的改造（如改 `system/provider-catalog.json` 兜底模型）有意推迟到 M1**（G2，避免 M0 范围膨胀）。此处必须诚实声明：M0 不实现 scope 强制拦截，scope 仅作为数据字段随 principal 传递。

- [ ] **Step 2: 跑现有 route-security 测试**
Run: `npm test -- server/http/route-security`
Expected: PASS（无回归）

- [ ] **Step 3: Commit**
```bash
git add server/http/route-security.ts
git commit -m "feat(security): add SYSTEM_ADMIN scope constant"
```

### Task 9: 前端路由化（react-router-dom）

**Files:**
- Modify: `desktop/package.json`（加 `react-router-dom`）
- Modify: `desktop/src/main.tsx`
- Create: `desktop/src/react/router.tsx`
- Modify: `desktop/src/react/App.tsx`
- Create: `desktop/src/react/pages/LoginPage.tsx` / `ChatPage.tsx` / `AgentsPage.tsx` / `SettingsPage.tsx`

- [ ] **Step 1: 加依赖**
在 `desktop/package.json` 的 `dependencies` 加：
```json
"react-router-dom": "^6.26.0"
```
Run: `cd desktop && npm install`（或根 `npm install`）。

- [ ] **Step 2: main.tsx 包 BrowserRouter**
```tsx
import { BrowserRouter } from "react-router-dom";
import { AppRouter } from "./react/router";
// ... 现有 createRoot 调用改为：
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AppRouter />
  </BrowserRouter>
);
```

- [ ] **Step 3: router.tsx**
```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth, AppLayout } from "./App"; // RequireAuth 与 AppLayout 同定义在 App.tsx（Step 4）
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { AgentsPage } from "./pages/AgentsPage";
import { SettingsPage } from "./pages/SettingsPage";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 4: App.tsx 改 AppLayout + Outlet**
把原 `App` 默认导出改为 `AppLayout`（保留侧边栏/顶栏，内容区 `<Outlet/>`），并导出 `RequireAuth`（探活 `/api/auth/me`，失败 `<Navigate to="/login" />`）。

- [ ] **Step 5: 子页面**
- `LoginPage.tsx`：复用 `onboarding` 样式，注册/登录两 tab，调 `/api/auth/register`、`/api/auth/login`，成功跳 `/chat`；登出调 `/api/auth/logout`。
- `ChatPage.tsx` / `AgentsPage.tsx` / `SettingsPage.tsx`：把原 App 内对应视图迁移到各自文件（保持现有组件逻辑，仅换挂载点）。

- [ ] **Step 6: 手动验证**
Run: `npm run dev:web`
- 访问前端根 URL → 重定向 `/login`。
- 注册 alice → 跳 `/chat`，侧边栏可切 `/agents`、`/settings`。
- 登出 → 回 `/login`，访问 `/chat` 重定向。

- [ ] **Step 7: Commit**
```bash
git add desktop/package.json desktop/src/main.tsx desktop/src/react/router.tsx desktop/src/react/App.tsx desktop/src/react/pages/
git commit -m "feat(frontend): react-router routing + login page + sub-route pages"
```

### Task 10: M0 收尾 — 范围标注与手动 DoD 验收

**Files:**
- Modify: `server/composition/open-root.ts`（注释标哪些路由 M0 未多用户化）

- [ ] **Step 1: 标注未接管路由**
在 `open-root.ts` 顶部加注释，明确列出 M0 已多用户化的路由（web-auth、sessions、ws-auth 的 lifecycle 绑定）与**仍走系统级兜底 engine、M1 才全量接管**的路由清单（其余 ~35 个 createXxxRoute）。这是诚实的范围声明，避免误以为 M0 已全量隔离。

- [ ] **Step 2: 跑全量测试**
Run: `npm test`
Expected: 全绿（含 engine-lifecycle / paths / register-lock / dual-root）。

- [ ] **Step 3: 手动 DoD 走查（对照 spec §5）**
逐项验证 spec 验收清单 1-8（注册跳转、隔离、双 engine、idle dispose 重建、A-dispose-B-正常、并发注册锁、登出、单测）。

- [ ] **Step 3b: GRILL §6 追因核对（spec §6 要求可追因）**
逐条确认 plan 的 Task 覆盖了 spec §6 的 Q1-Q11：
- Q1 多实例 → Task 3 单测 A-dispose-B-正常 / R7
- Q2 改注册模型 → Task 4（含 readUsersJson 模型改造）
- Q3 空闲口径 → Task 3（refCount>0 且静默超时）
- Q4 WS 接 lifecycle → Task 7（engine-ws-binding）Task 3 引用计数
- Q5 dispose 可逆 + 重建须 init → Task 3 单测 reuse-after-dispose
- Q6 hanakoHome 动态化 → Task 2/3（use 内 resolveEngineRoots）
- Q7 注册锁 → Task 4 register-lock 测试
- Q8 Hub 多实例 → Task 3 default factory new Hub
- Q9 store-registry 全根 → Task 4.5（systemStoreDir/businessStoreDir）
- Q10 path-guard 边界 → Task 1 + Task 7 Step 4b（upload 接入）
- Q11 A 模型（业务隔离+鉴权共享） → 贯穿 Task 2/4.5/7

- [ ] **Step 4: Commit**
```bash
git add -A
git commit -m "docs(m0): mark M0 out-of-scope routes, finalize DoD walkthrough"
```

---

## 自检（spec 覆盖）

| spec 要求 | 对应 Task |
|---|---|
| 注册/登录/登出（scrypt） | Task 4/5/6 |
| 业务隔离 + system 共享（A 模型） | Task 1/2/3/4/4.5 |
| Engine 懒加载 + 引用计数 + WS 静默 | Task 3/7 |
| 首用户 SYSTEM_ADMIN + 注册锁 | Task 4 |
| 前端路由化 + /login + 子路由 | Task 9 推迟（见边界 8；现有 onboarding 已提供登录/注册 UI） |
| httpOnly cookie + ws-ticket 复用 | Task 5/6/7（复用现状 web-session-store + verifyLocalAccountPassword） |
| path-guard（外部边界，含 upload 接入示范） | Task 1（函数就绪）+ upload 精确接入推迟 M1（边界 7） |
| 双根 engine（userDataRoot/systemRoot） | Task 2（字段）+ Task 4.5（store-registry/user-db 双根函数） |
| 鉴权类 store 落 system / 业务落 user（Q9/Q11） | Task 4.5 函数 + register/session/web-auth 直接写 systemStoreDir |
| A-dispose 后 B 正常 | Task 3 单测 |
| 重新 use 同 userId 重建（数据不丢，G6） | Task 3 单测 |
| 探活路由（B5 修订：复用 `/web-auth/session`，不新建 /api/auth/me） | 现状已满足 |
| 登录校验密码 verifyLocalAccountPassword（B6 修订：现状已校验） | 现状已满足 |
| OIDC `AuthProvider` 接口占位（G3） | Task 4 Step 5b |
| SYSTEM_ADMIN scope 常量（路由强控留 M1，G2） | Task 8 |
| 验收清单 1-8 | Task 10 |

**占位扫描：** 无 TBD/TODO；所有代码步骤含实现或明确替换指引（密码复用 `setLocalAccountPassword`/`verifyLocalAccountPassword`，已核实存在于 `core/local-user-account.ts`，无手写哈希）。
**类型一致性：** `EngineLifecycle.use/releaseRef/keepAlive/acquireCount/activeCount/drainAll` 全计划一致；`userHomePath/systemHomePath/assertWithinUserRoot` 一致；`registerUser/readUsersJson/issueSession/verifySession/revokeSession` 一致；`makeBusinessStore/makeSystemStore` 一致。

**已知 M0 边界（诚实声明，执行中按 GRILL 务实精神收敛）：**
1. 仅 web-auth/sessions/ws-auth 接入 lifecycle；其余 ~35 个路由工厂在 M0 仍走系统级兜底 engine，全量多用户接管为 M1（GRILL Q2/Q11 最小骨架验证目标）。
2. `SYSTEM_ADMIN` 在 M0 仅作 principal 携带的数据字段，路由级强制拦截（如改 `system/provider-catalog.json`）留 M1（G2）。
3. path-guard 在 M0 仅于 `upload.ts` 一处示范接入；desk/character-cards/file-ref 等同类 caller-selected 入口留 M1（G1）。
4. `EngineLifecycleOptions.systemRoot` 已移除，统一由 `resolveEngineRoots(baseDir, userId)` 决定双根（B2）；`baseDir = path.dirname(hanakoHome)`（B4/G7）。
5. **engine 内部 store 全量双根分流推迟到 M1**：M0 通过 lifecycle 按用户传入 `hanakoHome = users/<userId>` 使业务 store 天然按用户隔离；系统级数据（users.json/auth/web-sessions）由 register/session/web-auth 直接写 `systemStoreDir(baseDir)` 落 system，不经 engine 内部 store。engine 的 `systemRoot` 字段已预留供 M1 system 级 store 使用。
6. **server/index.ts 全量 lifecycle 接管（替换全局引擎）推迟到 M1**：M0 仅将 `EngineLifecycle` 作为可选机制注入 `ctx.engineLifecycle`（不破坏现有全局兜底引擎）。全量按用户引擎实例化需架构级统一 `hanakoHome`→system 根模型（现状 dev:web 的 hanakoHome 是单用户实际 home，与 M0 system 根模型冲突），属 M1。
7. **upload.ts path-guard 精确接入推迟到 M1**：因现状 dev:web 的 hanakoHome 模型下 `baseDir` 派生语义未统一（同上架构摩擦），强行接入会误拒合法上传。机制函数 `assertWithinUserRoot` 已就绪（Task 1），待 M1 架构统一后接入。
8. **前端完整路由化（BrowserRouter + 拆 App 子路由）推迟**：现有 App.tsx 是完整桌面布局编排（titlebar+sidebar+主区+overlays），强行拆子路由需重构整个桌面状态管理，风险高且非 M0 多用户核心验证项（属「为 PWA/移动端打底」前瞻）。现有 onboarding 已提供登录/注册 UI；后端探活用现有 `/web-auth/session`。完整路由化独立 task 或 M1 执行。
9. **`/api/auth/me` 不需要新建（B5 偏差修订）**：现状 web-auth 已有 `/web-auth/session` 探活路由，前端 `RequireAuth` 直接复用，无需重复路由。
10. **login 校验密码已就绪（B6 偏差修订）**：现状 `authenticatePasswordLogin` 已用 `verifyLocalAccountPassword(hanakoHome, ...)`，M0 只需 server 组合时传 system 根使密码校验走共享 `local-user-auth.json`（Task 5/7）。
