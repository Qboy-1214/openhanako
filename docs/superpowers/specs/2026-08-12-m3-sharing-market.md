# M3 设计规格（Spec）：内置/分享三级（Sharing Market）

> 本 spec 由 brainstorming 流程逐段确认（6 节设计全部批准）。
> 上游依据：REARCHITECTURE.md ADR-8（三级）/ADR-13（schema 布局）/ADR-16（分享市场 API）/ADR-17（userId 注入）。
> 前置里程碑：M2（用户脚本工具 + 无代码工作流 + Docker 沙箱，已交付）。
> 范围决策：A —— M3 仅做 **C 级 Sharing Market**（发布/发现/安装/撤回 + 前端市场 UI），B 级 fork 私有沿用 M2 已有机制，不额外立项。
> 已确认的关键决策（brainstorming 5 问 + 方案 X + 6 节审批）：
> 1. 范围 A：仅 C 级，含前端 UI；B 级复用 M2。
> 2. 本地分享源 = A：直查 `shared_assets` 表，单一数据源，不复用 `PluginMarketplace` 的 json 加载。
> 3. 分享内容 = A：源码包（工具源码 / 工作流 JSON + meta），落 `system/shared/`，与 M2 对齐。
> 4. 前端 UI = A：四页闭环（浏览/搜索、详情+安装、我的发布/安装、从私有资产发起发布）。
> 5. 版本更新 = A：M3 不做更新提醒，仅 `version`/`updated_at` 比对展示"有新版本"徽标，不推送、不自动覆盖。
> 6. 方案 X：索引表 + 内容目录双轨，安装走复用管线（`registerUserScript` / `compileWorkflow` + `assertInsideDir`）。
> 7. kind 范围：M3 首版仅 `tool` + `workflow`（与 M2 已建对齐）；`agent`/`skill` 留接口位不实现发布。

---

## 1. 整体架构与边界

M3 = **在 M2 用户资产层之上，新增"用户间分享"闭环**：私有资产 → 发布到系统级 `shared_assets` 索引 + `system/shared/` 内容目录 → 同实例全员发现/安装（安装即 fork 到调用者 UserHome）→ 撤回。

**架构分层（自上而下）**
1. **路由层**（`server/routes/sharing.ts`）：6 个端点（publish/discover/assets/:id/install/delete/mine），注入 `engineLifecycle` + `sharingMarket`，userId 来自 ADR-17 的 `user-engine-middleware`（从 `principal.userId` 注入 `c.get("engine")`）。
2. **分享核心层**（`server/sharing/index.ts`）：`SharingMarket` 类，封装 `shared_assets` 表读写 + `system/shared/` 内容目录管理，是路由与 SystemDB 之间的唯一边界（决策2=A，不依赖 `PluginMarketplace` json）。
3. **资产来源层**（M2 已建）：`users/<userId>/tools/`、`users/<userId>/workflows/` 为发布原料；安装落地复用 M2 的 `registerUserScript` / `compileWorkflow`。
4. **执行内核**（M2 已建）：安装后的资产经 `createSandboxedTools` 的 exec 后端一律进强沙箱（ADR-16 §8.9.6.1 安全基线）。

**关键边界不变式**
- H1：发布只能提升**自己** UserHome 的私有资产（path-guard 校验 sourcePath 落在 `users/<userId>/` 内）。
- H2：安装即 fork——在调用者本地资产落盘文件（tool: `manifest.json`；workflow: Q2 新增的 `graph.json`/`manifest.json`）写 `forkedFrom=asset_id`；原作者更新不自动覆盖（决策5，Q7 落点=A）。
- H3：任何安装的分享资产执行时**一律进 ADR-10 强沙箱**，不依赖人工审核（ADR-12.2 已决议）。**落实方式（Q9=A）**：M2 当前 `userScriptExecutor` 对 `origin="user"` 传空 `execBackend`，js/ts 仅走 vm 轻沙箱、py/sh 实际不执行；故 M3 安装管线对 fork 资产显式标记 `sandboxed:true`，引擎执行时强制注入 `createBwrapExec`/`createDockerExec` 后端（来自 `createSandboxedTools`，ADR-10 OS 级强沙箱），私有 tool 维持 M2 现状不被波及。
- H4：`shared_assets` 表为单一真相源；`system/shared/` 内容目录与表行一一对应。
- H5：作者注销（ADR-12.5）后，其分享资产转 `system_owned=1` 保留，不连累已安装者。

---

## 2. 组件与接口

### 2.1 SystemDB schema 迁移（ADR-13 落地）

`shared_assets` 表（复用现有 `better-sqlite3` + `store-registry.ts`）：
```sql
CREATE TABLE shared_assets (
  asset_id     TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- tool|workflow（M3 首版；agent|skill 留接口位）
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,   -- 决策5："有新版本"徽标比对
  origin_ref   TEXT,                        -- fork 来源 asset_id（若有）
  visibility   TEXT NOT NULL DEFAULT 'instance',
  install_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  system_owned INTEGER NOT NULL DEFAULT 0   -- 作者注销转 1（ADR-12.5）
);
```
> 相比 ADR-13 原稿补充 `version` / `updated_at`，支撑决策5 徽标，且不引入推送。

### 2.2 文件系统布局（HANA_HOME 新增 `system/shared/`）

```
HANA_HOME/
├─ system/
│  ├─ system.sqlite                 # 含 shared_assets 表
│  └─ shared/<assetId>/             # 分享内容（源码包，决策3）
│       ├─ meta.json                # name/kind/version/ownerHandle/description/readme
│       └─ source/                  # tool: script 源码 | workflow: graph.json
└─ users/<userId>/...               # M2 私有资产层（发布原料来源）
```
- `system/shared/` 受 `assertInsideDir(sharedRoot, target)` 同级 path-guard 保护（H1/H4）。
- 注销转移（ADR-12.5）：作者软删到期 → 物理删其 UserHome，但 `system/shared/<assetId>/` **保留**，`shared_assets.owner_id` 置 `__system__`、`system_owned=1`。

### 2.3 SharingMarket 核心模块（`server/sharing/index.ts`）

```ts
export interface SharedAssetMeta {
  assetId: string; ownerId: string; ownerHandle: string;
  kind: "tool" | "workflow"; name: string; version: number;
  description?: string; readme?: string;
  originRef?: string; installCount: number;
  createdAt: number; updatedAt: number; systemOwned: boolean;
}

export class SharingMarket {
  constructor(db, sharedRoot: string, accounts: AccountLookup) {}
  // 发布（Q11=A）：assetId = crypto.randomUUID()（复用项目惯例，不可预测/防枚举/零碰撞）
  //   → 拷贝 sourcePath 到 sharedRoot/<assetId>/source → 写 meta.json → INSERT（version=1）
  //   若传 existingAssetId 且属同一 owner，则视为重发：定位旧行、version+1、覆盖源目录（即 bumpVersion 语义内联）
  publish(ownerId, sourcePath, kind, name, description?, existingAssetId?): SharedAssetMeta
  // 发现：直查表，excludeOwnerId 默认当前用户；按 install_count DESC
  discover(opts: { kind?; q?; page?; pageSize?; excludeOwnerId? }): SharedAssetMeta[]
  getAsset(assetId): SharedAssetMeta | null
  getAssetContentPath(assetId): string          // → sharedRoot/<assetId>/source
  install(assetId, installerId): { localAssetId: string; version: number }  // 仅 install_count+1
  unpublish(assetId, requesterId): void          // 仅 owner / system 管理员；删索引+源目录
  listMine(userId): { published: SharedAssetMeta[]; installed: LocalInstall[] }
  // LocalInstall：调用者侧 fork 副本回溯记录
  //   { localAssetId: string; assetId: string; forkedFrom: string; kind: "tool"|"workflow"; name: string; version: number }
  // 数据来源（Q6 决策=A）：运行时扫 users/<userId>/tools/ 与 users/<userId>/workflows/，
  //   过滤出本地资产元数据中 forkedFrom 非空的条目；与 Q4 启动扫描共享同一 catalog，
  //   故 listMine 直接读内存 catalog（已含 forkedFrom），不再二次落盘查库。
  // bumpVersion 已内联进 publish(existingAssetId?)：仅当显式传旧 assetId 且 owner 一致才 version+1；
  //   否则每次发布都是新 assetId（新快照行），避免 PRIMARY KEY 冲突（Q11=A）。
  transferOnDelete(ownerId): void                // 注销转移：owner_id→__system__, system_owned=1
}
```
- **职责切分**：`publish` 管文件拷贝 + 索引插入；`install` 只动计数，文件落到调用者目录由路由层（复用安装管线）完成。
- **不依赖 `PluginMarketplace` json 加载**（决策2=A）：发现列表直查表，`ownerHandle` 经 `AccountLookup`（轻量注入，避免耦合 auth 模块）join。
- **内容落盘与索引分离**，单一职责；`sharedRoot` 下所有读写经 `assertInsideDir` 防逃逸。

### 2.4 路由与端点契约（`server/routes/sharing.ts` + `full-root.ts`）

```
POST   /api/sharing/publish
  body: { localAssetId: string; kind: "tool"|"workflow"; name: string; description?: string; existingAssetId?: string }
  → assetId = existingAssetId（仅当属同一 owner 且存在，走重发 version+1）否则 crypto.randomUUID()（Q11=A，新快照行）
  → **localAssetId 形态白名单校验（Q10=A）**：必须匹配 ^[a-zA-Z0-9_-]+$，禁止 "/" 与 ".."，否则 400
  → localAssetId → sourcePath 映射：tool 为 users/<userId>/tools/<localAssetId>/，workflow 为 users/<userId>/workflows/<localAssetId>/
  → 校验 sourcePath 落在 users/<userId>/<kind>s/<localAssetId>/ 内（H1 + 白名单双重保险：防跨用户 + 防同用户内子目录穿越/类型错配），assertInsideDir 二次确认，调 sharingMarket.publish
  resp: { assetId: string; version: number }

GET    /api/sharing/discover?kind=&q=&page=&pageSize=
  → sharingMarket.discover（excludeOwnerId = 当前用户）
  resp: { items: DiscoverItem[]; total: number }

GET    /api/sharing/assets/:id
  → sharingMarket.getAsset + 读 meta.json 的 readme
  resp: { ...DiscoverItem; readme?: string }   // 决策5：hasUpdate 由前端比对版本，后端不推

POST   /api/sharing/install
  body: { assetId: string; asFork?: boolean }   // asFork 默认 true
  → 走安装管线（§2.5）
  resp: { assetId: string; localAssetId: string; installedVersion: number }

DELETE /api/sharing/assets/:id
  → sharingMarket.unpublish（仅 owner / system 管理员）
  resp: { ok: true }

GET    /api/sharing/mine
  → sharingMarket.listMine(userId)
  resp: { published: SharedAssetMeta[]; installed: LocalInstall[] }
```

```ts
interface DiscoverItem {
  assetId: string; ownerId: string; ownerHandle: string;
  kind: "tool" | "workflow"; name: string; description?: string;
  installCount: number; createdAt: number; version: number;
  forkedFrom?: string; systemOwned: boolean;
}
```
- **userId 来源**：复用 ADR-17 `user-engine-middleware`（`principal.userId` → `c.get("engine")`），路由无需逐个改。
- **权限/安全**：所有端点非 PUBLIC，缺失 principal → 403；`publish` 校验 sourcePath 落 `users/<userId>/`；`unpublish` 校验 owner/system；解包目标经 `assertInsideDir` 限 `users/<userId>/`。

### 2.5 安装管线复用与沙箱兜底

**安装流程（`POST /install` 内部）**
```
1. sharingMarket.getAssetContentPath(assetId) → system/shared/<assetId>/source
2. 拷贝 source → users/<userId>/<kind>s/<newLocalId>/
3. 复用 M2 机制落地：
   - tool:     registerUserScript(catalog, userId, def) 注册到调用者引擎（origin="user"）；def 序列化进 manifest.json 时带 forkedFrom=assetId **与 `sandboxed:true`**（Q9=A 标记）
   - workflow: compileWorkflow(graph) → 写 script.js 到 users/<userId>/workflows/<id>/；并在同目录落 graph.json（**Q2+Q8 落点=A**：回改 M2 `POST /api/workflows` handler，编译后顺手 `fs.writeFile(graph.json, 原始请求 JSON)`；研发阶段正向生效，所有新 workflow 自带 graph，M3 发布直接读现成文件，不改 `script.js` 读回路径、不污染编译器纯函数）→ graph.json 带 forkedFrom=assetId（Q7=A）与 `sandboxed:true`（Q9=A）
4. forkedFrom 已落本地资产文件（Q7=A），由 Q4 启动扫描读入内存 catalog，供 listMine.installed 回溯
5. sharingMarket.install(assetId, userId) → install_count + 1
6. 返回 { assetId, localAssetId, installedVersion }
```
- **复用映射**（ADR-16 §8.9.5）：`registerUserScript` / `compileWorkflow`（M2）+ `assertInsideDir` / 50MB 上限（防逃逸与超包）+ `PluginInstallRecords`（per-user 隔离自动生效）。
- **沙箱兜底**（ADR-16 §8.9.6.1，Q9=A 落实）：M2 `userScriptExecutor` 当前对 `origin="user"` 传空 `execBackend`（js/ts 仅 vm 轻沙箱、py/sh 实际不执行），故不能靠"复用注册"自然获得强沙箱。M3 对标记 `sandboxed:true` 的 fork 资产，在引擎执行入口（扩展 `userScriptExecutor` / `_buildBridgeTools`）强制注入 `createBwrapExec` 或 `createDockerExec` 后端（来自 `createSandboxedTools`，ADR-10 OS 级强沙箱），使 py/sh 真正进沙箱、js/ts 升级为 OS 级隔离；私有 tool（无 `sandboxed` 标记）维持 M2 现状。即便分享资产含恶意脚本，只能伤调用者自身（fail-closed）。M3 首版不区分信任分级。
- **一致性**：安装即 fork（H2）；撤回不影响已装 fork（§2.4 delete 只删索引+源目录）；解包目标限 `users/<userId>/`。

### 2.6 前端四页 UI

- **浏览页 `/market`**：列表卡片（名称、kind 徽标、作者 handle、安装数、系统所有标记）；kind 过滤 + 关键词搜索；默认 `install_count DESC`；点击 → 详情。
- **详情页 `/market/:id`**：meta + README + 作者 + 版本 + `forked_from` 链；「安装」按钮（`POST /install`，asFork 默认 true）；决策5 徽标：若 `version` 高于调用者已装 `forked_from` 版本，显示「作者已更新 ↻」（不自动覆盖，提示可重装）。
- **我的页 `/market/mine`**：分区「我发布的」（含撤回按钮，仅 owner 可见）+「我安装的」（来自 `forked_from` 回溯，显示 origin 当前版本便于判断是否重装）。
- **发布入口**：嵌入「我的私有资产」列表，每项旁「发布到市场」按钮 → 弹窗填 name/描述 → `POST /publish`（决策4 简化发布 UI）。
- **组件落地**：新建 `MarketPage` 系列组件（浏览/详情/我的），保留现有 `SharingTab.tsx` 作为设置入口（重写为 Web 化、跳转 `/market`）。新增 `marketApi` 模块对应 §2.4 端点，复用项目现有 HTTP client。

---

## 3. 数据流与错误处理

### 数据流（端到端）

**发布**
```
用户在「我的私有资产」点「发布」
  → POST /api/sharing/publish { localAssetId, kind, name }
  → 路由读 users/<userId>/<kind>s/<localAssetId>/sourcePath
  → sharingMarket.publish：拷贝到 system/shared/<assetId>/source + 写 meta.json + INSERT shared_assets(version=1)
  → resp { assetId }
```

**发现与安装**
```
B 打开 /market → GET /api/sharing/discover（excludeOwnerId=B）
  → 列表展示 A 发布的 tool
B 点详情 → GET /api/sharing/assets/:id → 看 README
B 点安装 → POST /api/sharing/install { assetId }
  → 拷贝 system/shared/<assetId>/source → users/<B>/tools/<newLocalId>/
  → registerUserScript 注册到 B 引擎（forked_from=assetId）
  → sharingMarket.install：install_count+1
B 调用该 tool → createSandboxedTools exec 后端进强沙箱执行
```

**撤回**
```
A 在 /market/mine 点「撤回」→ DELETE /api/sharing/assets/:id
  → sharingMarket.unpublish：删 shared_assets 行 + system/shared/<assetId>/
  → B 已装 fork 副本独立，仍可调用（H2）
```

### 错误处理

| 场景 | 处理 |
|---|---|
| publish 时 `localAssetId` 形态非法（含 `/`、`..` 或非 `^[a-zA-Z0-9_-]+$`） | 400（Q10=A 白名单，先于路径拼接） |
| publish 时 sourcePath 越界（非自己 UserHome 或同用户内子目录穿越） | `assertInsideDir` 拒绝 → 403 |
| publish 资产 kind 非 tool/workflow | 400（M3 仅支持两种） |
| discover 参数非法（page<1） | 400 |
| install 资产不存在 / 已撤回 | 404 |
| install 解包目标越界 | `assertInsideDir` → 403 |
| unpublish 非 owner / 非 system | 403 |
| 原作者注销（ADR-12.5） | `transferOnDelete`：owner_id→__system__, system_owned=1，资产保留可装 |
| 分享资产执行越权 FS/Net | 沙箱拒绝（H3 强沙箱兜底） |

**不变量**：fail-closed——不跨用户泄漏、不降级无沙箱执行、不静默吞错；撤回不影响已装 fork。

---

## 4. 测试策略与验收

### 测试分层（vitest，`npx vitest` 入口）

**单元/集成测试（新增 `tests/sharing/`）**
- `sharing-market.test.ts`：
  - publish 后 `shared_assets` 有行 + `system/shared/<id>/source` 存在 + meta.json 正确。
  - discover 过滤（kind/q/excludeOwnerId）+ 排序（install_count DESC）。
  - install 仅 +1 计数不拷源；unpublish 仅 owner 可，已装副本不受影响。
  - transferOnDelete：作者注销后 `owner_id=__system__`、`system_owned=1`，资产仍可 discover。
  - path-guard：`assertInsideDir` 阻止越界路径。

**集成测试（新增 `tests/integration/`）**
- `sharing-flow.test.ts`：模拟两用户 A、B。
  - A 发布私有 tool → B discover 可见 → B install → B 引擎能调用该 tool（走沙箱）→ install_count+1。
  - A 撤回后，B 已装 tool 仍可调用（fork 隔离）。
  - B 重新发布自己 fork 的副本（二级 fork 链 `forked_from` 正确）。

**沙箱兜底验证**
- 分享安装的 tool 执行时断言落入 M2 沙箱（FS 仅挂用户子集、网络禁），复用 M2 沙箱测试夹具。

**前端验收**
- `MarketPage` 组件测试：浏览列表渲染、详情安装按钮、mine 撤回按钮可见性（owner 才显示）。
- 手动验收清单：四页闭环走通（发布→发现→安装→撤回）。

### 验收门槛（Definition of Done）
1. 所有新增 `tests/sharing/` + 集成测试通过（`npx vitest run`）。
2. M3 改动文件 `tsc --noEmit` 零错误（M2 既有债务不计入）。
3. `full-root.ts` 挂载 `createSharingRoute`，`/api/sharing/*` 端到端可通。
4. 沙箱兜底测试证明分享资产强制进强沙箱。

### 范围边界（YAGNI）
- 不做 B 级显式"fork 为副本"UI（沿用 M2 私有机制）。
- 不做更新提醒/推送（决策5，仅版本徽标）。
- 不做 `agent`/`skill` 发布（M3 仅 tool/workflow）。
- 不做内容审核/举报、跨实例联邦分享（ADR-16 §8.9.7 后续）。
- 不新建 `PluginMarketplace` 的 json 视图（决策2=A，直查表）。

---

## 5. Implementation Status

> 状态：**已实现并验证**（代码落盘于 commit `a85a614c`「feat(m3): implement Sharing Market」及后续 fix commits）。

### 实际交付（对照 spec 各 §）
- §2.1 索引表 `shared_assets`（全字段 + UNIQUE + 索引）→ `server/sharing/store.ts` `SharingAssetStore`（v1）。
- §2.2 文件系统布局（`system/shared/<assetId>/source` 双轨 + `users/<userId>/` 双根）→ Task 1/4/5。
- §2.3 SharingMarket 接口（publish/discover/getAsset/install/unpublish/listMine/transferOnDelete + Q11 randomUUID + ownerHandle/AccountLookup）→ `server/sharing/index.ts`。
- §2.4 路由契约（6 端点 + Q1 `/api/sharing/mine` + Q10 白名单 + Q7 forkedFrom + Q11 existingAssetId + DiscoverItem `{items,total}`）→ `full-root.ts` `createSharingRoute`。
- §2.5 分享管线（发布/安装/卸载/注销转移 + Q2 graph + Q7 forkedFrom + Q9 sandboxed）→ Task 4/5。
- §2.6 前端四页（新增 `market` tab，Zustand `currentTab`，非 router）→ Task 6。
- §3 错误表（kind 非 tool/workflow→400｜page<1→400｜install 不存在→404｜白名单非法→400（Q10 优先）+ assertInsideDir 纵深 400/403｜越权 unpublish→403｜缺失 principal→401）→ Task 3/5。
- §4 注册（`store-registry.ts` 注册 `shared-assets-sqlite` + 路由挂载 + 启动扫描 + 前端 tab）→ 已注册并通过 persistence inventory census + Schema Tripwire（fingerprint 分类 `compatible`）。

### 持久化基线落地补遗（本 spec 未预见、M3 验收时补齐）
- `scripts/generate-persistence-schema-fingerprint.mjs` 新增 `sharedAssetsSchema()` runtime introspector。
- `shared/persistence/store-registry.ts` 补 `register-bookkeeping-on-register` / `user-home-destruction-on-unregister` / `user-workflows-runtime` 三个 exemption（上游主干写操作注册），并为 `user-studio-registries` 补 `unregister.ts` siteRule。

### 验证
- `node scripts/scan-persistent-stores.mjs`：干净 inventory（62 stores / 793 sites）。
- `npx vitest run tests/persistence-schema-tripwire.test.ts tests/persistence-store-registry.test.ts`：29 passed / 29。
- `vitest.config.js` `testTimeout` 10s→30s（全量扫描用例单条约 9.7s~21.4s）。

### 偏差
- spec §2.4「缺失 principal → 403」以代码为准为 **401**（越权仍 403）。
- localStorage 缓存、自动覆盖升级、ADR-12.5 注销转移触发链路、B 级市场归 out-of-scope（spec §6）。
