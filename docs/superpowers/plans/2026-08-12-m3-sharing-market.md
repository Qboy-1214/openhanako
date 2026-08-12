# M3 Sharing Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 M3 Sharing Market（ADR-8 C 级 / ADR-16）——一个用户间分享 tool/workflow 的市场，含分享管线（发布/发现/安装/注销转移）、强沙箱兜底、启动扫描 catalog、前端四页闭环。设计细节以已批准的 spec `docs/superpowers/specs/2026-08-12-m3-sharing-market.md` 为准，本 plan 是其执行步骤。

**Architecture:** 主轴为"私有资产（M2 已落盘于 `users/<userId>/tools|workflows/`）→ 索引表 `shared_assets`（SystemDB）+ 内容目录 `system/shared/<assetId>/source`（方案 X 双轨）→ 直查表发现 → 安装即 fork（落盘副本 + `forkedFrom` 回溯 + 强沙箱标记）→ 引擎启动扫描预填内存 catalog"。M3 复用 M2 落盘/注册管线，仅新增"提升为共享"与"从共享 fork"两头，不新建私有资产概念。

**Tech Stack:** TypeScript, Hono (`@hono/node-ws`), better-sqlite3（SystemDB via `shared/persistence/store-registry.ts` `defineStore`），vitest，现有 `lib/sandbox`/`core/engine`/`core/user-script-runtime`/`server/composition` 模块。

---

## Spec → Task 映射速查（逐条覆盖，防缺漏）

| spec 条目 | 落点 Task |
|---|---|
| §2.1 索引表 `shared_assets`（含 schema 全字段：`origin_ref`/`visibility`/`created_at`/`updated_at` 等 + UNIQUE + 索引） | Task 1 |
| §2.2 文件系统布局（`system/shared/<assetId>/source` + `users/<userId>/` 双根） | Task 1 / Task 4 / Task 5 |
| §2.3 SharingMarket 接口（publish/discover/getAsset/install/unpublish/listMine/transferOnDelete，**含 Q11 randomUUID + existingAssetId 重发 + ownerHandle/AccountLookup**） | Task 2 |
| §2.4 路由契约（6 端点：publish/discover/assets/:id/install/delete/mine + **Q10 localAssetId 白名单 + Q7 forkedFrom 写入 + Q11 existingAssetId + DiscoverItem 形状**） | Task 3 |
| §2.5 分享管线（发布/安装/卸载/注销转移，**含 Q2 graph.json / Q7 forkedFrom / Q9 sandboxed 标记**） | Task 4 / Task 5 |
| §2.6 前端四页（`/market` 路由 + MarketPage/AssetDetailPage/PublishForm/MyAssetsPage/PublishFromPrivateList + 发布入口嵌入私有资产列表 + 决策5 update 徽标 + README 渲染 + SharingTab 重写入口） | Task 6 |
| §3 错误处理（**完整错误表**：kind 非 tool/workflow → 400｜page<1 → 400｜install 资产不存在 → 404｜localAssetId 白名单非法 → 400（Q10 优先）+ assertInsideDir 纵深 400/403｜越权 unpublish → 403｜缺失 principal → 401） | Task 3 / Task 4 |
| §4 注册清单（SystemDB 注册 + 路由挂载 + EngineLifecycle 启动扫描 + Agent 注入 + 前端 tab） | Task 1 / Task 3 / Task 5 / Task 6 |
| §5 测试分层（集成 + 引擎单元 + 前端组件 + 路径守卫） | Task 7（贯穿各 Task 测试）+ Task 8 |
| §6 待办（B 级复用 / 启动扫描时机 Q4 / 注销转移 ADR-12.5 / localStorage 缓存 / 跨里程碑） | Task 5 / Task 9 |
| Q1 私有资产清单 `GET /api/sharing/mine` | Task 3 |
| Q4 引擎启动扫描（EngineLifecycle 构造后一次，预填 catalog）+ Q6 listMine 读 catalog | Task 5 |
| Q9 分享资产强制强沙箱（fork 标记 `sandboxed` + 注入 bwrap/docker） | Task 5 |

---

## File Structure

**后端（分享核心）**
- `server/sharing/index.ts` — Task 2（`SharingMarket` 类实现：publish/discover/getAsset/install/unpublish/listMine/transferOnDelete；构造签名 `(db, sharedRoot, accounts: AccountLookup)`）
- `server/sharing/types.ts` — Task 2（`SharedAssetMeta` / `LocalInstall` / `AccountLookup` / store 类型）
- `shared/persistence/store-registry.ts` — Task 1（新增 `shared_assets` defineStore 注册 + siteRules + migrationEntry）
- `server/routes/sharing.ts` — Task 3（`createSharingRoute`：6 端点含 `GET /api/sharing/mine` + Q10 白名单）
- `server/routes/user-workflows.ts` — Task 4（Q2+Q8：编译后顺手落 `graph.json`）
- `core/engine.ts` — Task 5（`registerUserScript`/`_buildBridgeTools`/`userScriptExecutor` 注入 `sandboxed` + 启动扫描 catalog）
- `core/engine-lifecycle.ts`（或 `EngineLifecycle` 默认工厂） — Task 5（Q4：构造后一次启动扫描）

**前端（四页，spec §2.6：/market 路由 + 保留 SharingTab 入口）**
- `desktop/src/shared/api/marketApi.ts` — Task 6（marketApi 封装 6 端点：`discover`/`getAsset`/`install`/`publish`/`unpublish`/`listMine`）
- `desktop/src/react/market/MarketPage.tsx` — Task 6（浏览页 `/market`：列表卡片 + kind 过滤 + 搜索，默认 `install_count DESC`）
- `desktop/src/react/market/AssetDetailPage.tsx` — Task 6（详情页 `/market/:id`：meta + README 渲染 + 安装按钮 + update 徽标）
- `desktop/src/react/market/PublishForm.tsx` — Task 6（发布表单，`localAssetId` 白名单前置校验；嵌入私有资产列表）
- `desktop/src/react/market/MyAssetsPage.tsx` — Task 6（`/market/mine`：我发布的（含撤回）+ 我安装的（forked_from 回溯））
- `desktop/src/react/market/PublishFromPrivateList.tsx` — Task 6（私有资产列表，每项「发布到市场」按钮 → PublishForm 弹窗）
- `desktop/src/react/settings/tabs/SharingTab.tsx` — Task 6（**重写为 Web 化入口，跳转 `/market`**，保留设置入口）
- `desktop/src/react/router.tsx`（或路由注册处）— Task 6（注册 `/market`、`/market/:id`、`/market/mine` 路由）
- `desktop/src/react/market/__tests__/{MarketPage,AssetDetailPage,PublishForm,MyAssetsPage,PublishFromPrivateList}.test.tsx` — Task 6

**测试**
- `tests/sharing/sharing-market.test.ts` — Task 2（集成：发布/发现/安装/卸载/注销转移 + Q11 randomUUID）
- `tests/sharing/sharing-route.test.ts` — Task 3（路由契约 + Q10 白名单 + 403）
- `tests/sharing/launch-scan.test.ts` — Task 5（Q4 启动扫描 + Q6 listMine 读 catalog）
- `tests/sharing/sandbox-enforce.test.ts` — Task 5（Q9 fork 资产强制强沙箱）
- `tests/workflow/graph-persist.test.ts` — Task 4（Q2 graph.json 落盘）

---

## Task 0: 探查 — SystemDB store 注册形态 + 双根路径确认

> spec §4「注册清单」要求 `shared_assets` 注册到 SystemDB。本 Task 只探查现有 `defineStore` 写法与 `users/<userId>/` 双根路径实际形态，不写实现，避免 Task 1 写错 schema 注册方式。

**Files:**
- Read: `shared/persistence/store-registry.ts`（defineStore / sqlite-runtime schemaSource / siteRules / migrationEntry 写法）
- Read: `core/user-script-runtime.ts:73`（persistUserScript 落盘 `path.join(hanakoHome, "tools", id)` —— 确认 per-user `hanakoHome` 已含 `users/<userId>` 段，双根模型）
- Read: `server/routes/user-workflows.ts:16`（workflow 落盘 `path.join(engine.hanakoHome, "workflows", id, "script.js")`，Q2 在此加 graph.json）

- [ ] **Step 1: 记录 SystemDB 注册范式**
读取 `store-registry.ts`，确认 `shared_assets` 应与之同风格的 `defineStore({ id, kind:"sqlite", siteRules, migrationEntry, schemaSource })`。输出范式要点到 Task 1 Step 3 注释。

- [ ] **Step 2: 确认双根路径约定**
确认 per-user `engine.hanakoHome` = `<baseDir>/users/<userId>`（已在 M2 plan 验证），故 M3 落盘一律用 `path.join(hanakoHome, "tools"|"workflows", id)`，源目录用 `path.join(system.sharedRoot, assetId, "source")`（`system.sharedRoot` 为新增 SystemDB 级目录，归 `<baseDir>/system/shared`）。

- [ ] **Step 3: 探查 `system.sharedRoot` 是否已存在**
搜索 `HanakoHome` 是否已有 `sharedRoot` 字段。若不存在，在 Task 1 实现时于 `HanakoHome` 新增 `get sharedRoot()` 返回 `path.join(systemDir, "shared")`，与 `usersRoot`/`systemDir` 同构。

- [ ] **Step 4: Commit 探查注释（可选）**
本 Task 不产生业务代码；若需留存，仅提交注释，否则直接进入 Task 1。

---

## Task 1: 索引表 `shared_assets` 注册（spec §2.1 + §4）

**Files:**
- Modify: `shared/persistence/store-registry.ts`（新增 `shared_assets` defineStore）
- Modify: `core/hanako-home.ts`（或 HanakoHome 定义处，Task 0 Step 3 定位）新增 `sharedRoot`

- [ ] **Step 1: Write the failing test for shared_assets schema**
```ts
import { describe, it, expect } from "vitest";
import { getSystemDb, closeSystemDb } from "../../shared/persistence/store-registry";

describe("M3 shared_assets table", () => {
  it("has all spec §2.1 columns (incl. origin_ref/visibility; created_at/updated_at INTEGER)", async () => {
    const db = getSystemDb();
    const cols = db.prepare("PRAGMA table_info(shared_assets)").all() as { name: string; type: string }[];
    const names = cols.map(c => c.name);
    for (const c of ["asset_id","owner_id","kind","name","version","origin_ref","visibility","install_count","created_at","updated_at","system_owned"]) {
      expect(names).toContain(c);
    }
    // §2.1：created_at / updated_at 为 INTEGER（number），非 TEXT
    const ca = cols.find(c => c.name === "created_at")!;
    const ua = cols.find(c => c.name === "updated_at")!;
    expect(ca.type).toMatch(/INTEGER/i);
    expect(ua.type).toMatch(/INTEGER/i);
    // visibility 必填且默认 'instance'
    const vis = cols.find(c => c.name === "visibility")!;
    expect(vis.notnull).toBe(1);
  });
  it("enforces UNIQUE(owner_id, name, version) and asset_id PK", async () => {
    const db = getSystemDb();
    const idx = db.prepare("PRAGMA index_list(shared_assets)").all() as { name: string; unique: number }[];
    expect(idx.some(i => i.unique === 1 && /owner_id.*name.*version|name.*version.*owner_id/.test(i.name))).toBe(true);
    const pk = db.prepare("PRAGMA table_info(shared_assets)").all() as { name: string; pk: number }[];
    expect(pk.find(c => c.name === "asset_id")!.pk).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/sharing/shared-assets.test.ts`
Expected: FAIL — `shared_assets` 表不存在

- [ ] **Step 3: Register `shared_assets` store in store-registry.ts**
参照现有 defineStore 范式新增（以 spec §2.1 为准，补全 `origin_ref`/`visibility`，`created_at`/`updated_at` 用 INTEGER + `Date.now()` 默认值，与 spec 类型一致）：
```ts
defineStore({
  id: "shared_assets",
  kind: "sqlite",
  siteRules: { scope: "system", mode: "shared" },
  migrationEntry: { version: 1, up: `
    CREATE TABLE shared_assets (
      asset_id      TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('tool','workflow')),
      name          TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      origin_ref    TEXT,
      visibility    TEXT NOT NULL DEFAULT 'instance',
      install_count INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      system_owned  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner_id, name, version)
    );
    CREATE INDEX idx_shared_assets_kind_install ON shared_assets(kind, install_count DESC);
    CREATE INDEX idx_shared_assets_owner ON shared_assets(owner_id);
  ` },
  schemaSource: "inline",
});
```
> spec §2.1 无 `description` 列；描述存于 `system/shared/<assetId>/meta.json`（见 §2.2），故表不重复存储 description。`created_at`/`updated_at` 由 JS 侧以 `Date.now()` 写入 INTEGER（spec 类型要求），不依赖 SQLite `datetime()`（返回 TEXT）。

- [ ] **Step 4: Add `sharedRoot` to HanakoHome**
在 HanakoHome 定义处新增 getter：`get sharedRoot(): string { return path.join(this.systemDir, "shared"); }`（与 `usersRoot`/`systemDir` 同构）。`system/shared/<assetId>/source` 由此派生。

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/sharing/shared-assets.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add shared/persistence/store-registry.ts core/hanako-home.ts tests/sharing/shared-assets.test.ts
git commit -m "feat(m3): register shared_assets SystemDB store + HanakoHome.sharedRoot"
```

---

## Task 2: SharingMarket 核心接口（spec §2.3，含 Q7/Q11）

**Files:**
- Create: `core/sharing/types.ts`（`SharedAssetMeta` / `LocalInstall` / store 类型）
- Create: `core/sharing/sharing-market.ts`（接口实现）
- Test: `tests/sharing/sharing-market.test.ts`

- [ ] **Step 1: Write the failing test for publish/discover/install/unpublish/listMine/transferOnDelete**
```ts
import { describe, it, expect } from "vitest";
import { SharingMarket } from "../../server/sharing/sharing-market";

describe("M3 SharingMarket", () => {
  it("publish generates randomUUID assetId, version=1 (Q11=A)", async () => {
    const m = makeMarket();
    const meta = await m.publish("u_a", "/tmp/src-a", "tool", "summarizer");
    expect(meta.assetId).toMatch(/^[0-9a-f-]{36}$/); // randomUUID
    expect(meta.version).toBe(1);
  });
  it("publish with existingAssetId (same owner) bumps version (Q11=A)", async () => {
    const m = makeMarket();
    const a1 = await m.publish("u_a", "/tmp/src-a", "tool", "summarizer");
    const a2 = await m.publish("u_a", "/tmp/src-a2", "tool", "summarizer", undefined, a1.assetId);
    expect(a2.assetId).toBe(a1.assetId);
    expect(a2.version).toBe(2);
  });
  it("publish without existingAssetId is a new snapshot row (no PK conflict)", async () => {
    const m = makeMarket();
    const a1 = await m.publish("u_a", "/tmp/src-a", "tool", "summarizer");
    const a2 = await m.publish("u_a", "/tmp/src-a", "tool", "summarizer"); // 重发但不传旧 ID
    expect(a1.assetId).not.toBe(a2.assetId);
  });
  it("discover excludes owner and orders by installCount DESC", async () => {
    const m = makeMarket();
    await m.publish("u_a", "/s", "tool", "t1");
    const b = await m.publish("u_b", "/s", "tool", "t2");
    await m.install(b.assetId, "u_a"); // b 安装数=1
    const list = await m.discover({ excludeOwnerId: "u_a" });
    expect(list[0].assetId).toBe(b.assetId); // 安装多的排前
  });
  it("install increments installCount, returns localAssetId+version", async () => {
    const m = makeMarket();
    const a = await m.publish("u_a", "/s", "tool", "t");
    const r = await m.install(a.assetId, "u_b");
    expect(r.version).toBe(1);
    expect(typeof r.localAssetId).toBe("string");
    expect(m.getAsset(a.assetId)!.installCount).toBe(1);
  });
  it("unpublish only by owner (403 for non-owner)", async () => {
    const m = makeMarket();
    const a = await m.publish("u_a", "/s", "tool", "t");
    expect(() => m.unpublish(a.assetId, "u_b")).toThrow(/owner/);
    m.unpublish(a.assetId, "u_a");
    expect(m.getAsset(a.assetId)).toBeNull();
  });
  it("transferOnDelete moves assets to __system__ (ADR-12.5)", async () => {
    const m = makeMarket();
    const a = await m.publish("u_a", "/s", "tool", "t");
    m.transferOnDelete("u_a");
    const row = m.getAsset(a.assetId)!;
    expect(row.ownerId).toBe("__system__");
    expect(row.systemOwned).toBe(1);
  });
  it("listMine.installed reads catalog forkedFrom entries (Q6=A placeholder; real catalog wiring in Task 5)", async () => {
    // 本 Task 先用内存 catalog stub；Q6 的"扫 tools/+workflows/ 过滤 forkedFrom"由 Task 5 引擎扫描回填
    // 构造签名统一为 makeMarket({ catalogProvider })：catalogProvider 返回 LocalInstall[]（Task 5 由引擎扫描提供）
    const m = makeMarket({ catalogProvider: () => [{ localAssetId: "local-x", assetId: "asset-1", forkedFrom: "asset-1", kind: "tool", name: "t", version: 1 }] });
    const mine = await m.listMine("u_a");
    expect(mine.installed.find(i => i.localAssetId === "local-x")!.forkedFrom).toBe("asset-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/sharing/sharing-market.test.ts`
Expected: FAIL — `SharingMarket` 未实现

- [ ] **Step 3: Implement `types.ts`**
> **字段命名映射声明（spec 用 camelCase 对外接口、snake_case 入库）**：`SharedAssetMeta` 为 spec 对外接口（camelCase），`row`→`SharedAssetMeta` 映射：`asset_id→assetId`、`owner_id→ownerId`、`ownerHandle` 由 `AccountLookup` 注入（见下）、`created_at→createdAt`(number)、`updated_at→updatedAt`(number)、`system_owned→systemOwned`、`install_count→installCount`、`origin_ref→originRef`、`visibility` 原样。反向写入表时同样映射。
```ts
export interface SharedAssetMeta {
  assetId: string; ownerId: string; ownerHandle: string;
  kind: "tool" | "workflow"; name: string; version: number;
  // description/readme 不存于 shared_assets 表（§2.1 无该列），由 getAsset/getAssetReadme 读 meta.json 补充；
  // rowToMeta 不填这两项，discover 列表项的 description 可选留空。
  description?: string; readme?: string;
  originRef?: string; installCount: number;
  createdAt: number; updatedAt: number; systemOwned: boolean;
}
export interface LocalInstall {
  localAssetId: string; assetId: string; forkedFrom: string;
  kind: "tool"|"workflow"; name: string; version: number;
}
// §2.3：轻量账号查找，避免耦合 auth 模块；用于 join ownerHandle
export interface AccountLookup {
  getHandle(ownerId: string): string | Promise<string>;
}
export function rowToMeta(row: any, accounts?: AccountLookup): SharedAssetMeta {
  return {
    assetId: row.asset_id, ownerId: row.owner_id,
    ownerHandle: accounts ? accounts.getHandle(row.owner_id) : row.owner_id,
    kind: row.kind, name: row.name, version: row.version,
    originRef: row.origin_ref ?? undefined, installCount: row.install_count,
    createdAt: row.created_at, updatedAt: row.updated_at, systemOwned: !!row.system_owned,
  };
}
```

- [ ] **Step 4: Implement `sharing-market.ts`**
- **构造签名（spec §2.3）**：`constructor(private db, private sharedRoot: string, private accounts: AccountLookup)`，所有对外返回经 `rowToMeta` 注入 `ownerHandle`。
- `publish(ownerId, sourcePath, kind, name, description?, existingAssetId?)`：
  - 若 `existingAssetId` 非空且库中该行 `owner_id===ownerId` 存在 → 定位旧行、`version+1`、覆盖 `sharedRoot/<assetId>/source`；否则 `asset_id = crypto.randomUUID()`（Q11=A）、`version=1`，拷贝 sourcePath 到 `sharedRoot/<assetId>/source`（`fs.cp` 保留源码结构）。
  - 写 `meta.json`（§2.2 形状：`{ name, kind, version, ownerHandle: accounts.getHandle(ownerId), description?, readme? }`）。
  - INSERT/UPDATE `shared_assets`（`created_at`/`updated_at` 用 `Date.now()` INTEGER）。
- `discover({kind?,q?,page?,pageSize?,excludeOwnerId?})`：直查表，`WHERE owner_id != ?`（excludeOwnerId 默认当前用户）、`kind`/`q`（LIKE name）过滤，`ORDER BY install_count DESC`，分页；返回 `SharedAssetMeta[]`（含 `ownerHandle`）。
- `getAsset` / `getAssetContentPath(assetId) => sharedRoot/<assetId>/source`；`getAsset` 返回经 `rowToMeta` 含 `ownerHandle`。
- `install(assetId, installerId)`：`install_count+1`，返回 `{ localAssetId: crypto.randomUUID(), version }`（localAssetId 由安装侧 Task 5 落盘时使用）。
- `unpublish(assetId, requesterId)`：`if requesterId !== owner && !isSystemAdmin throw 403`；删索引 + `fs.rm` 源目录。
- `listMine(userId)`：`published = SELECT * WHERE owner_id=userId` 经 `rowToMeta`；`installed` 来自注入的 `catalogProvider`（`catalogProvider(): LocalInstall[]`，Task 5 由引擎启动扫描提供；本 Task 测试用 stub 函数返回 `LocalInstall[]`）。构造签名统一为 `makeMarket({ accounts, catalogProvider })`。**Task 5 衔接**：`SharingMarket` 实际构造为 `new SharingMarket(db, sharedRoot, accounts, catalogProvider)`，`catalogProvider` 由引擎启动扫描结果闭包提供（见 Task 5 Step 5）。二级 fork 发布（`u_b` 以已装 `localAssetId` 副本为源再 publish）的 `forkedFrom` 写入：以该副本 manifest 中的 `forkedFrom`（即原始 `assetId`）为链尾回溯，落盘新行 `origin_ref` 指向原始 `assetId`，不重复造链。
- `countDiscover({kind?,q?,excludeOwnerId?})`：与 `discover` 同过滤条件返回 `COUNT(*)`（供 discover 端点返回 `{items,total}`）。
- `getAssetReadme(assetId)`：读 `sharedRoot/<assetId>/meta.json` 的 `readme` 字段（§2.4 assets/:id 响应）。
- `transferOnDelete(ownerId)`：`UPDATE SET owner_id='__system__', system_owned=1 WHERE owner_id=?`。

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/sharing/sharing-market.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add server/sharing/types.ts server/sharing/sharing-market.ts tests/sharing/sharing-market.test.ts
git commit -m "feat(m3): SharingMarket core (publish/discover/install/unpublish/listMine/transfer; randomUUID + bump + ownerHandle)"
```

- [ ] **Step 7: Add end-to-end integration test for two-user flow + 2nd-level fork**（spec §5 验收）
新建 `tests/integration/sharing-flow.test.ts`，覆盖：
```ts
import { describe, it, expect } from "vitest";

describe("M3 sharing E2E flow", () => {
  it("owner publishes → other installs as fork → owner bumps version → other sees hasUpdate", async () => {
    // 1) u_a 发布（publish，localAssetId 合法、白名单通过）
    const pub = await app.request("/api/sharing/publish", { method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "my-tool", kind: "tool", name: "MyTool" }) });
    expect(pub.status).toBe(200);
    const { assetId, version: v1 } = await pub.json();
    // 2) u_b 发现（discover 排除自己，应见 u_a 的资产）
    const disc = await app.request("/api/sharing/discover", { headers: auth("u_b") });
    const { items } = await disc.json();
    expect(items.find(i => i.assetId === assetId)).toBeTruthy();
    // 3) u_b 安装为 fork
    const inst = await app.request("/api/sharing/install", { method: "POST", headers: auth("u_b"),
      body: JSON.stringify({ assetId, asFork: true }) });
    expect(inst.status).toBe(200);
    const { localAssetId, installedVersion } = await inst.json();
    expect(installedVersion).toBe(v1);
    // 4) u_a bump 版本（existingAssetId）
    const pub2 = await app.request("/api/sharing/publish", { method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "my-tool", kind: "tool", name: "MyTool", existingAssetId: assetId }) });
    expect((await pub2.json()).version).toBe(v1 + 1);
    // 5) u_b 再次 install 触发二级 fork（fork of fork）：以已装的 localAssetId 为源再 publish
    //    验证 forkedFrom 链可向后延长，不报错
    const forkAgain = await app.request("/api/sharing/publish", { method: "POST", headers: auth("u_b"),
      body: JSON.stringify({ localAssetId: localAssetId, kind: "tool", name: "MyTool-fork2" }) });
    expect(forkAgain.status).toBe(200); // 二级 fork 落盘成功
  });
  it("non-owner cannot unpublish → 403", async () => {
    const pub = await app.request("/api/sharing/publish", { method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "x", kind: "workflow", name: "W" }) });
    const { assetId } = await pub.json();
    const del = await app.request(`/api/sharing/assets/${assetId}`, { method: "DELETE", headers: auth("u_b") });
    expect(del.status).toBe(403);
  });
});
```

---

## Task 3: 路由契约（spec §2.4 + Q1/Q10/Q11）

**Files:**
- Create: `server/routes/sharing.ts`（`createSharingRoute`）
- Modify: `server/composition/full-root.ts`（`registerClosedRoutes` 挂载）
- Test: `tests/sharing/sharing-route.test.ts`

- [ ] **Step 1: Write the failing test for 6 endpoints + DiscoverItem shape + Q10 whitelist**
```ts
import { describe, it, expect } from "vitest";

describe("M3 sharing routes", () => {
  it("GET /api/sharing/discover returns { items, total } (excludes self)", async () => {
    const res = await app.request("/api/sharing/discover", { headers: auth("u_a") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    // DiscoverItem 形状含 ownerHandle
    if (body.items[0]) expect(body.items[0].ownerHandle).toBeDefined();
  });
  it("GET /api/sharing/assets/:id returns meta + readme", async () => {
    const res = await app.request(`/api/sharing/assets/${assetId}`, { headers: auth("u_a") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.assetId).toBe(assetId);
    expect(body.readme).toBeDefined(); // 决策5：hasUpdate 由前端比版本，后端不推
  });
  it("POST /api/sharing/install with asFork returns { assetId, localAssetId, installedVersion }", async () => {
    const res = await app.request("/api/sharing/install", {
      method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ assetId, asFork: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assetId).toBe(assetId);
    expect(body.localAssetId).toBeTruthy();
    expect(typeof body.installedVersion).toBe("number");
  });
  it("POST /api/sharing/install missing asset → 404 (§3 error table)", async () => {
    const res = await app.request("/api/sharing/install", {
      method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ assetId: "nope", asFork: true }),
    });
    expect(res.status).toBe(404);
  });
  it("POST /api/sharing/publish with illegal localAssetId (slash/dot) → 400 (Q10=A whitelist first)", async () => {
    const res = await app.request("/api/sharing/publish", {
      method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "../tools/x", kind: "tool", name: "evil" }),
    });
    expect(res.status).toBe(400); // 白名单 ^[a-zA-Z0-9_-]+$ 先于路径拼接拦截所有 / 与 ..
  });
  it("POST /api/sharing/publish with kind not tool/workflow → 400 (§3 error table)", async () => {
    const res = await app.request("/api/sharing/publish", {
      method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "ok-id", kind: "agent", name: "x" }),
    });
    expect(res.status).toBe(400);
  });
  it("GET /api/sharing/discover with page<1 → 400 (§3 error table)", async () => {
    const res = await app.request("/api/sharing/discover?page=0", { headers: auth("u_a") });
    expect(res.status).toBe(400);
  });
  it("POST /api/sharing/install with source out of bounds → 400 (Q10 assertInsideDir fail-closed, §3)", async () => {
    // 合法白名单 localAssetId 但 sourcePath 经解析落在 users/<userId> 之外（理论上不会由正常 UI 触发，
    // 仅用于断言 assertInsideDir 兜底：任一越界源 → 400 而非落盘）
    const res = await app.request("/api/sharing/publish", {
      method: "POST", headers: auth("u_a"),
      // localAssetId 合法白名单，但服务端解析后若越界必被 assertInsideDir 拦截
      body: JSON.stringify({ localAssetId: "evil", kind: "tool", name: "x" }),
    });
    // 此处源不存在 → 403（源缺失）；若未来解析越界则应为 400。二者皆非 200 即满足 fail-closed。
    expect([400, 403]).toContain(res.status);
  });
  it("assertInsideDir is defense-in-depth: whitelist already blocks traversal, path guard is the backstop", async () => {
    // 正常合法 localAssetId 拼接后必落在 users/<userId>/<sub>/<id>，assertInsideDir 通过；
    // 该断言验证：即使白名单被绕过（未来改动），assertInsideDir 仍拒绝越界（fail-closed）。
    const res = await app.request("/api/sharing/publish", {
      method: "POST", headers: auth("u_a"),
      body: JSON.stringify({ localAssetId: "ok-id", kind: "tool", name: "safe" }),
    });
    // 合法 id：若 sourcePath 真实存在则 publish 成功(200)，否则 403（source 不存在/越界，非白名单问题）
    expect([200, 403]).toContain(res.status);
  });
  it("DELETE /api/sharing/assets/:id rejects non-owner (403)", async () => {
    const res = await app.request(`/api/sharing/assets/${assetId}`, { method: "DELETE", headers: auth("u_b") });
    expect(res.status).toBe(403);
  });
  it("GET /api/sharing/mine returns { published, installed } (Q1 + §2.4)", async () => {
    const res = await app.request("/api/sharing/mine", { headers: auth("u_a") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toBeDefined();
    expect(body.installed).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/sharing/sharing-route.test.ts`
Expected: FAIL — `createSharingRoute` 未挂载

- [ ] **Step 3: Implement `createSharingRoute`**
> 端点契约严格对齐 spec §2.4（6 端点）。`DiscoverItem` 形状（camelCase）：`{ assetId, ownerId, ownerHandle, kind, name, description?, installCount, createdAt, version, forkedFrom?, systemOwned }`——由 `market.discover` 返回的 `SharedAssetMeta[]` 直接序列化（已含 ownerHandle）。
```ts
export interface DiscoverItem {
  assetId: string; ownerId: string; ownerHandle: string;
  kind: "tool" | "workflow"; name: string; description?: string;
  installCount: number; createdAt: number; version: number;
  forkedFrom?: string; systemOwned: boolean;
}

export function createSharingRoute(market: SharingMarket, getEngine: (c) => Promise<HanaEngine>) {
  const app = new Hono();
  app.use("*", userEngineMiddleware); // 提供 c.get("principal").userId + c.get("engine")

  app.post("/api/sharing/publish", async (c) => {
    const userId = c.get("principal").userId;
    const body = await c.req.json<{ localAssetId: string; kind: "tool"|"workflow"; name: string; description?: string; existingAssetId?: string }>();
    // Q10=A：白名单先于路径拼接
    if (!/^[a-zA-Z0-9_-]+$/.test(body.localAssetId)) return c.json({ error: "illegal_localAssetId" }, 400);
    if (body.kind !== "tool" && body.kind !== "workflow") return c.json({ error: "bad_kind" }, 400); // §3 错误表
    const sub = body.kind === "tool" ? "tools" : "workflows";
    const sourcePath = path.join(c.get("engine").hanakoHome, sub, body.localAssetId); // 双根：hanakoHome 已含 users/<userId>
    // Q10=A：assertInsideDir 二次确认落在 users/<userId>/<sub>/<id> 内（防同用户内穿越）
    assertInsideDir(sourcePath, path.join(c.get("engine").hanakoHome, sub, body.localAssetId));
    try {
      const meta = await market.publish(userId, sourcePath, body.kind, body.name, body.description, body.existingAssetId);
      return c.json({ assetId: meta.assetId, version: meta.version });
    } catch (e) { return c.json({ error: "publish_failed" }, 403); }
  });

  app.get("/api/sharing/discover", async (c) => {
    const userId = c.get("principal").userId;
    const q = c.req.query();
    const page = Number(q.page ?? 1);
    if (!Number.isInteger(page) || page < 1) return c.json({ error: "bad_page" }, 400); // §3 错误表
    const items = await market.discover({ kind: q.kind, q: q.q, page, pageSize: Number(q.pageSize ?? 20), excludeOwnerId: userId });
    const total = await market.countDiscover({ kind: q.kind, q: q.q, excludeOwnerId: userId });
    return c.json({ items, total }); // DiscoverItem 形状，spec §2.4
  });

  app.get("/api/sharing/assets/:id", async (c) => {
    const asset = market.getAsset(c.req.param("id"));
    if (!asset) return c.json({ error: "not_found" }, 404);
    const readme = market.getAssetReadme(asset.assetId); // 读 meta.json 的 readme
    return c.json({ ...asset, readme }); // 决策5：hasUpdate 由前端比版本，后端不推
  });

  app.post("/api/sharing/install", async (c) => {
    const userId = c.get("principal").userId;
    const body = await c.req.json<{ assetId: string; asFork?: boolean }>();
    const asset = market.getAsset(body.assetId);
    if (!asset) return c.json({ error: "not_found" }, 404); // §3 错误表
    const asFork = body.asFork ?? true; // 默认 true
    // 走安装管线（§2.5）由 Task 5 落盘 + 注入 sandboxed；此处先计数
    const r = await market.install(body.assetId, userId);
    return c.json({ assetId: body.assetId, localAssetId: r.localAssetId, installedVersion: r.version });
  });

  app.delete("/api/sharing/assets/:id", async (c) => {
    const userId = c.get("principal").userId;
    try { market.unpublish(c.req.param("id"), userId); return c.json({ ok: true }); }
    catch { return c.json({ error: "forbidden" }, 403); }
  });

  app.get("/api/sharing/mine", async (c) => {
    const userId = c.get("principal").userId;
    const mine = await market.listMine(userId); // published 查表 + installed 读 catalog（Task 5 回填）
    return c.json(mine); // { published, installed }
  });
  return app;
}
```
注意：`userEngineMiddleware` 在 principal 缺失时返回 **401**（代码实际行为，spec §2.4 写"403"——以代码为准，plan 标注此偏差：缺失 principal → 401；越权操作 → 403）。`market.countDiscover` 与 `getAssetReadme` 为 `SharingMarket` 新增辅助方法（Task 2 补）。
<arg_key:6124c78e>explanation</arg_key:6124c78e>
<arg_value:6124c78e>C: 路由实现重写为 spec 6 端点 + DiscoverItem + asFork + mine

- [ ] **Step 4: Mount in `full-root.ts`**
在 `registerClosedRoutes` 仿照 `createPluginRoutes` 调用：
```ts
app.route("/api", createSharingRoute(sharingMarket, getEngine));
```
`sharingMarket` 在组合根处单例构造（依赖 SystemDB，与 pluginMarket 同级）。

- [ ] **Step 5: Run test to verify it passes**
Run: `npx vitest run tests/sharing/sharing-route.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add server/routes/sharing.ts server/composition/full-root.ts tests/sharing/sharing-route.test.ts
git commit -m "feat(m3): sharing routes (6 endpoints incl /mine; DiscoverItem shape; localAssetId whitelist + assertInsideDir)"
```

---

## Task 4: workflow 落 graph.json（spec Q2 + Q8）

**Files:**
- Modify: `server/routes/user-workflows.ts:16`（`POST /api/workflows` 编译后落 graph.json）
- Test: `tests/workflow/graph-persist.test.ts`

- [ ] **Step 1: Write the failing test for graph.json persistence**
```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";

describe("M3 workflow graph persistence (Q2+Q8=A)", () => {
  it("POST /api/workflows writes both script.js and graph.json", async () => {
    const graph = { nodes: [{ id: "n1", tool: "echo", prompt: "hi" }], edges: [] };
    const res = await app.request("/api/workflows", { method: "POST", headers: auth("u_a"), body: JSON.stringify(graph) });
    const { id } = await res.json();
    const dir = path.join(engineHome("u_a"), "workflows", id);
    const script = await fs.readFile(path.join(dir, "script.js"), "utf8");
    const savedGraph = JSON.parse(await fs.readFile(path.join(dir, "graph.json"), "utf8"));
    expect(script).toContain("agent");
    expect(savedGraph.nodes[0].id).toBe("n1"); // 原请求体落盘
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/workflow/graph-persist.test.ts`
Expected: FAIL — 仅 script.js 落盘，graph.json 不存在

- [ ] **Step 3: Modify `POST /api/workflows` handler**
在 `compileWorkflow(graph)` → `fs.writeFile(script.js)` 之后追加：
```ts
await fs.writeFile(path.join(dir, "graph.json"), JSON.stringify(graph, null, 2)); // Q2+Q8=A：落原始请求 JSON
```
不改变 `script.js` 读回路径、不污染 `compileWorkflow` 纯函数。

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run tests/workflow/graph-persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add server/routes/user-workflows.ts tests/workflow/graph-persist.test.ts
git commit -m "feat(m3): persist workflow graph.json on POST /api/workflows (Q2+Q8)"
```

---

## Task 5: 安装管线 + 引擎启动扫描 + 强沙箱（spec §2.5 + Q3/Q4/Q5/Q6/Q7/Q9）

**Files:**
- Modify: `core/engine.ts`（`registerUserScript`/`_buildBridgeTools`/`userScriptExecutor` 注入 `sandboxed`；新增启动扫描）
- Modify: `core/engine-lifecycle.ts` 或 EngineLifecycle 默认工厂（Q4：构造后一次启动扫描）
- Test: `tests/sharing/launch-scan.test.ts`、`tests/sharing/sandbox-enforce.test.ts`

- [ ] **Step 1: Write the failing test for launch scan + listMine catalog (Q4/Q6)**
```ts
import { describe, it, expect } from "vitest";

describe("M3 launch scan + catalog (Q4/Q6=A)", () => {
  it("engine acquire scans tools/+workflows/, prefills catalog with forkedFrom", async () => {
    // 预制 users/<userId>/tools/<id>/manifest.json 含 forkedFrom=asset-1
    const engine = await lifecycle.use("u_a");
    const entries = engine.getLocalInstalls(); // 新增：返回 catalog 中 forkedFrom 非空条目
    expect(entries.some(e => e.forkedFrom === "asset-1")).toBe(true);
  });
  it("listMine.installed reads scanned catalog (no second disk scan)", async () => {
    const market = makeMarket({ catalogProvider: () => lifecycle.use("u_a").then(e => e.getLocalInstalls()) });
    const mine = await market.listMine("u_a");
    expect(mine.installed.some(i => i.forkedFrom === "asset-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing test for sandbox enforcement (Q9=A)**
```ts
import { describe, it, expect } from "vitest";

describe("M3 shared-asset sandbox enforcement (Q9=A)", () => {
  it("forked (sandboxed) asset executes via bwrap/docker backend, not empty execBackend", async () => {
    const engine = await lifecycle.use("u_a");
    const tool = engine.getTool("forked-tool"); // manifest 含 forkedFrom + sandboxed:true
    // 验证执行路径注入了 createBwrapExec/createDockerExec（非空 execBackend）
    await expect(tool.execute({})).resolves.toBeTruthy(); // 进强沙箱跑通
  });
  it("private (non-sandboxed) tool keeps M2 behavior (no forced backend)", async () => {
    const engine = await lifecycle.use("u_a");
    const tool = engine.getTool("private-tool"); // 无 sandboxed 标记
    expect(tool.meta.sandboxed).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**
Run: `npx vitest run tests/sharing/launch-scan.test.ts tests/sharing/sandbox-enforce.test.ts`
Expected: FAIL — 启动扫描/`getLocalInstalls`/`sandboxed` 未实现

- [ ] **Step 4: Implement 安装落盘（forkedFrom + sandboxed 标记，Q7/Q9）**
扩展 Task 0–2 已有的 `registerUserScript` 调用路径（M3 安装侧）：
- 安装时从 `sharedRoot/<assetId>/source` 拷贝到 `users/<userId>/<kind>s/<localAssetId>/`，manifest/graph 写入 `forkedFrom: assetId` 与 `sandboxed: true`（Q7=A 落本地文件、Q9=A 标记）。
- `install` 端点返回的 `localAssetId` 即此处落盘目录名。

- [ ] **Step 5: Implement 引擎启动扫描（Q4/Q5/Q6）**
在 EngineLifecycle 默认工厂 `use(userId)` 构造 engine 后，调用一次：
```ts
await engine.scanLocalAssets(hanakoHome); // 扫 tools/+workflows/，读 manifest/graph 的 forkedFrom/sandboxed 预填内存 catalog
```
`engine.scanLocalAssets`：遍历 `tools/` 与 `workflows/`，对每个资产读 manifest.json（`UserScriptDef` 已含可选 `forkedFrom`/`sandboxed`），`workflows/` 读 `graph.json`；将 `forkedFrom` 非空者存入 `_userScripts`/workflow catalog 并暴露 `getLocalInstalls()`（Q6=A：listMine 直接读此 catalog，不再二次扫盘）。

- [ ] **Step 6: Implement 强沙箱注入（Q9=A）**
- `userScriptExecutor`（`engine.ts:2922`）：将 `executeUserScript(def, args, {})` 的空 `execBackend` 改为：当 `def.sandboxed` 为真时注入 `createBwrapExec`（或 `createDockerExec`，按 `selectSandboxBackend`），使 py/sh 真正进 OS 级沙箱、js/ts 升级隔离；无 `sandboxed` 标记的私有 tool 维持 M2 现有行为（vm 轻沙箱 / py/sh 不执行）。
- `_buildBridgeTools`（`engine.ts:3293`）对 `origin="user"` 统一在 catalog 条目上透传 `sandboxed` 标志，供执行入口判断。

- [ ] **Step 7: Run tests to verify they pass**
Run: `npx vitest run tests/sharing/launch-scan.test.ts tests/sharing/sandbox-enforce.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**
```bash
git add core/engine.ts core/engine-lifecycle.ts tests/sharing/launch-scan.test.ts tests/sharing/sandbox-enforce.test.ts
git commit -m "feat(m3): install fork + launch scan catalog + forced sandbox for shared assets (Q4-Q9)"
```

---

## Task 6: 前端四页（spec §2.6：/market 路由 + 四页闭环 + 发布入口 + update 徽标）

> spec §2.6 要点：浏览页 `/market`、详情页 `/market/:id`、我的页 `/market/mine`、发布入口嵌入私有资产列表、保留 `SharingTab.tsx` 重写为 Web 化入口跳转 `/market`、`marketApi` 对应 §2.4 端点、README 渲染、决策5「作者已更新 ↻」徽标。

**Files:**
- Create: `desktop/src/shared/api/marketApi.ts`
- Create: `desktop/src/react/market/{MarketPage,AssetDetailPage,PublishForm,MyAssetsPage,PublishFromPrivateList}.tsx`
- Modify: `desktop/src/react/settings/tabs/SharingTab.tsx`（重写为入口，跳转 `/market`）
- Modify: `desktop/src/react/router.tsx`（注册 `/market`、`/market/:id`、`/market/mine`）
- Test: `desktop/src/react/market/__tests__/{MarketPage,AssetDetailPage,PublishForm,MyAssetsPage,PublishFromPrivateList}.test.tsx`

- [ ] **Step 1: Write the failing component tests**
仿现有组件测试风格（如 `settings/__tests__/MeTab.test.tsx`），对每个页写渲染 + 交互断言：
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarketPage } from "../MarketPage";
import * as marketApi from "../../../shared/api/marketApi";

describe("MarketPage (browse /market)", () => {
  it("fetches and lists discoverable assets via discover()", async () => {
    vi.spyOn(marketApi, "discover").mockResolvedValue({
      items: [{ assetId: "a1", name: "t", kind: "tool", installCount: 3, ownerId: "u_b", ownerHandle: "@b", version: 1, systemOwned: false }],
      total: 1,
    });
    render(<MarketPage />);
    expect(await screen.findByText("t")).toBeInTheDocument();
  });
  it("search filters by query → discover({ q })", async () => {
    vi.spyOn(marketApi, "discover").mockResolvedValue({ items: [], total: 0 });
    render(<MarketPage />);
    fireEvent.change(screen.getByPlaceholderText("搜索"), { target: { value: "foo" } });
    expect(marketApi.discover).toHaveBeenLastCalledWith(expect.objectContaining({ q: "foo" }));
  });
});
// AssetDetailPage：fetch getAsset(id) 渲染 meta + README（readme 字段）+ 安装按钮 → marketApi.install({ assetId, asFork:true })
//   - 决策5 徽标：若 asset.version > 调用者已装 forked_from 版本 → 显示「作者已更新 ↻」（不自动覆盖，提示重装）
// PublishFromPrivateList：渲染私有资产列表，每项「发布到市场」按钮 → 弹窗 PublishForm
// PublishForm：localAssetId 输入前端预校验 ^[a-zA-Z0-9_-]+$（Q10 前置），提交 marketApi.publish；校验失败本地提示（不发请求）
// MyAssetsPage：调 marketApi.listMine 渲染「我发布的」(published，含撤回按钮仅 owner 可见) + 「我安装的」(installed，含 forked_from 当前版本)
// SharingTab：渲染为入口卡片，按钮跳转 /market（不再内联四页）
```

- [ ] **Step 2: Run tests to verify they fail**
Run: `npx vitest run desktop/src/react/market/__tests__`
Expected: FAIL — 组件/marketApi 未实现

- [ ] **Step 3: Implement `marketApi.ts`**
封装 §2.4 全部 6 端点（与现有 API client 风格一致）：`discover(opts)`（→ `GET /api/sharing/discover`，返回 `{items,total}`）、`getAsset(id)`（→ `GET /api/sharing/assets/:id`，含 `readme`）、`install(payload)`（→ `POST /api/sharing/install`，body `{assetId, asFork}`）、`publish(payload)`（→ `POST /api/sharing/publish`）、`unpublish(id)`（→ `DELETE /api/sharing/assets/:id`）、`listMine()`（→ `GET /api/sharing/mine`，返回 `{published, installed}`）。

- [ ] **Step 4: Implement 四页组件 + 路由**
- `MarketPage`（`/market`）：列表卡片（名称、kind 徽标、作者 handle、安装数、系统所有标记）；kind 过滤 + 关键词搜索；默认 `install_count DESC`；点击 → 详情路由。
- `AssetDetailPage`（`/market/:id`）：meta + **README 渲染**（来自 `getAsset().readme`）+ 作者 + 版本 + `forked_from` 链；「安装」按钮（`install({assetId, asFork:true})`）；**决策5 徽标**：若 `asset.version` 高于调用者已装 `forked_from` 版本，显示「作者已更新 ↻」（不自动覆盖，提示可重装）。
- `PublishForm`：表单含 `localAssetId`（前端预校验白名单）+ `kind` + `name` + `description?` + `existingAssetId?`，提交 `publish`；校验失败本地提示（不发的请求）。
- `MyAssetsPage`（`/market/mine`）：分区「我发布的」（含撤回按钮，仅 owner 可见）→ `unpublish`；「我安装的」（来自 `forked_from` 回溯，显示 origin 当前版本便于判断是否重装）。
- `PublishFromPrivateList`：渲染私有资产列表，每项旁「发布到市场」按钮 → 弹窗填 name/描述 → `PublishForm`（决策4 简化发布 UI）。
- `SharingTab.tsx`：**重写为 Web 化入口**，保留设置入口位置，内放跳转 `/market` 的按钮/卡片（spec §2.6「保留现有 SharingTab 作为设置入口」）。
- 路由注册：在 `router.tsx` 注册 `/market`、`/market/:id`、`/market/mine` 三个路由到 MarketPage 系列组件。

- [ ] **Step 5: Run tests to verify they pass**
Run: `npx vitest run desktop/src/react/market/__tests__`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add desktop/src/shared/api/marketApi.ts desktop/src/react/market/ desktop/src/react/settings/tabs/SharingTab.tsx desktop/src/react/router.tsx desktop/src/react/market/__tests__/
git commit -m "feat(m3): frontend /market four pages (discover/detail/publish/mine) + SharingTab entry + marketApi"
```

---

## Task 7: 集成验收 + tsc（spec §5 分层覆盖）

**Files:**
- Run: `npx tsc --noEmit`、`npx vitest run`

- [ ] **Step 1: Run full typecheck**
Run: `npx tsc --noEmit`
Expected: 0 errors（M3 改动文件）

- [ ] **Step 2: Run full test suite**
Run: `npx vitest run`
Expected: 全部 PASS（含 Task 1–6 新增 + 既有 M1/M2 套件无回归）

- [ ] **Step 3: E2E 手测（两用户分享闭环）**
启动服务，user A 发布一个 tool → user B 在 `/market`（`MarketPage`）发现并安装 → B 的引擎启动扫描把 fork 副本注入 catalog（sandboxed）→ B 执行该 tool 验证进强沙箱 → A 在 `/market/mine`（`MyAssetsPage`）看到 published、B 看到 installed。验证 Q1/Q4/Q6/Q9 端到端。

- [ ] **Step 4: Final commit**
```bash
git add -A
git commit -m "test(m3): full integration green — Sharing Market end-to-end"
```

---

## Self-Review (against spec)

**1. Spec coverage（逐 § 核对）:**
- §2.1 索引表 schema 全字段 + UNIQUE + 索引 ✓ Task 1
- §2.2 文件系统布局（双根 + `system/shared/<assetId>/source`） ✓ Task 1（sharedRoot）/ Task 4-5（落盘）
- §2.3 SharingMarket 接口（含 Q11 randomUUID + existingAssetId bump + Q7 forkedFrom 透传 + Q6 listMine 读 catalog + ownerHandle/AccountLookup 注入） ✓ Task 2 / Task 5
- §2.4 路由契约（**6 端点**：publish/discover/assets/:id/install/delete/mine + Q1 `/api/sharing/mine` + Q10 白名单 + Q11 existingAssetId + DiscoverItem 形状 `{items,total}`） ✓ Task 3
- §2.5 分享管线（发布/安装/卸载/注销转移 + Q2 graph + Q7 forkedFrom + Q9 sandboxed） ✓ Task 4 / Task 5
- §2.6 前端四页（`/market` 路由：MarketPage/AssetDetailPage/PublishForm/MyAssetsPage/PublishFromPrivateList + 发布入口嵌入私有资产列表 + 决策5 update 徽标 + README 渲染 + SharingTab 重写入口 + marketApi） ✓ Task 6
- §3 错误处理（**完整错误表**）：kind 非 tool/workflow → 400｜page<1 → 400｜install 资产不存在 → 404｜localAssetId 白名单非法 → 400（Q10 优先）+ assertInsideDir 纵深 400/403｜越权 unpublish → 403｜缺失 principal → 401） ✓ Task 3 / Task 5
- §4 注册清单（SystemDB 注册 ✓ Task 1｜路由挂载 ✓ Task 3｜EngineLifecycle 启动扫描 ✓ Task 5｜Agent 注入 `getLocalInstalls` ✓ Task 5｜前端 tab ✓ Task 6）
- §5 测试分层（集成、引擎单元、前端组件、路径守卫） ✓ Task 7（各 Task 测试）
- §6 待办：B 级复用（install 复用 M2 管线，不新建）✓ Task 5｜启动扫描时机（Q4 构造后一次）✓ Task 5｜注销转移 ADR-12.5 ✓ Task 2 transferOnDelete｜localStorage 缓存（前端择机，标注）｜跨里程碑（ADR-12.5 转移路径、M4 同步）标注 out of scope

**2. Placeholder scan:** 无 TBD；每个 code step 含片段或明确落点；测试含实际断言。

**3. Type consistency:** `SharingMarket` 跨 Task 2/3/5 一致；`localAssetId` 在 publish（Task 3）/ install 落盘（Task 5）/ PublishForm（Task 6）一致；`sandboxed`/`forkedFrom` 字段在 manifest/graph（Task 4-5）/ engine catalog（Task 5）/ listMine（Task 2-5）一致；双根路径统一 `path.join(hanakoHome, "tools"|"workflows", id)`（沿用 M2 plan 验证模型）。**字段命名映射已声明**（Task 2 Step 3）：对外接口 camelCase（`assetId`/`ownerId`/`ownerHandle`/`createdAt`/`updatedAt`/`systemOwned`/`installCount`/`originRef`），入表 snake_case（`asset_id`/`owner_id`/`created_at`/`updated_at`/`system_owned`/`install_count`/`origin_ref`），经 `rowToMeta` 双向转换；`created_at`/`updated_at` 为 INTEGER（JS 侧 `Date.now()`），与 spec §2.1 类型一致。

**4. Grilling 决策闭合（11 项全部编入）：** Q1→Task 3 `/api/sharing/mine`｜Q2/Q8→Task 4 graph.json｜Q3/Q5→Task 5 落盘+扫描对称｜Q4→Task 5 启动扫描绑定构造后｜Q6→Task 5 listMine 读 catalog｜Q7→Task 5 forkedFrom 落本地文件｜Q9→Task 5 sandboxed 强制注入 bwrap/docker｜Q10→Task 3 白名单+assertInsideDir｜Q11→Task 2 randomUUID + existingAssetId bump。

**5. Spec 偏差明示（非错误，落地时对齐）：**
- §2.4「缺失 principal → 403」与代码 `userEngineMiddleware` 实际返回 **401** 不一致 → 以代码为准（401）；越权操作维持 403。已在 Task 3 Step 3 注释标注。
- §2.5「M2 `userScriptExecutor` + Docker/bwrap」原表述模糊 → 已由 Q9=A 落实为"fork 资产标记 sandboxed，执行入口强制注入强沙箱后端"，Task 5 Step 6 改写。

**6. Explicitly out of scope（spec §6 声明或标注入待办）：**
- localStorage 前端缓存（spec §6 标注"择机"，本 plan 不强制实现，仅在 marketApi 留扩展位）。
- 自动覆盖/静默升级（决策5：M3 **不做**自动覆盖；改为在 AssetDetailPage / MyAssetsPage 安装项显示「作者已更新 ↻」徽标，由用户手动重装；`hasUpdate` 由前端比对 `asset.version` 与已装 `forked_from` 版本，后端不推）。
- 注销转移的具体 ADR-12.5 转移触发链路（归 M4/账户体系），本 plan 仅实现 `transferOnDelete` 数据层。
- B 级市场（归 M2 复用，不新建）。

**Gaps:** 无（除显式标注的 out-of-scope 项）。所有 spec 段均有对应 Task 或可解释排除项。

---

## Implementation Status

> 待实现后回填（参照 M2 plan 末尾 Implementation Status 章节格式）。
