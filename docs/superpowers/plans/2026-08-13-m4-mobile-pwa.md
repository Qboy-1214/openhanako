# M4 实现计划：移动 / PWA / Bridge 账号级绑定

> 配套 spec：`docs/superpowers/specs/2026-08-13-m4-mobile-pwa-design.md`
> 设计决策与 grill-me 拷问结论已落定（见 spec §0 决策表 + §1–§6 的 grill-me 标注）。
> 本 plan 的所有符号均经 code-explorer 核实真实存在，禁止照搬旧 plan 的占位符。

## 0. 本轮核实的真实代码底数（落点精度）

| 主题 | 真实符号 | 备注 |
|---|---|---|
| 移动壳入口 | `desktop/src/mobile-main.tsx` + `desktop/src/react/mobile/`（`MobileApp.tsx`、`mobile-init.ts`、`MobileApp.css`、`mobile-entry.css`） | 非 `main.tsx` 别名，独立 Vite entry |
| SW 注册 | `desktop/src/react/mobile/mobile-init.ts` 经 `registerMobileServiceWorker()` 调 `navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })` | 文件名是 `sw.js`，**非** `mobile-sw.js`；默认 scope 已落在 `/mobile/` 下 |
| SW 供货 | `server/routes/mobile-static.ts` 的 `serveWebClientFile` → `safeRelativePath` 白名单含 `sw.js` / `manifest.webmanifest`，**不含 `mobile-manifest.webmanifest`** | 真实缺口：若保留 `mobile-manifest.webmanifest` 名需补白名单 |
| 移动壳状态 | `MobileApp` 用 Zustand `useStore`（桌面全局 store），`mobile-init.ts` 已注入 `{ sidebarOpen:false, jianOpen:false, previewOpen:false }` 防御桌面态 | 印证 grill-me 拷问 3·A 现状已部分满足 |
| Bridge 路由 | `server/routes/bridge.ts` 的 `createBridgeRoute(app, args)`；绑定写 `agent.config.bridge[platform].owner`（`/owner`）、凭据 `/credentials` | 账号级 token 落点需新增端点 |
| Owner 解析 | `lib/bridge/owner-policy.ts` 的 `resolveBridgeOwnerUserId({ platform, agent, index })` 按 `agent.config.bridge[platform].owner` 解析 | grill-me 拷问 2·A 要在此之外新增 token→userId 反查 |
| 平台白名单 | `lib/bridge/session-key.ts` 的 `KNOWN_PLATFORMS` | 绑定表单 platform 选项来源 |
| 用户偏好 | `core/preferences-manager.ts` 的 `PreferencesManager`（per-user 单例，管 `preferences.json`）已有 `getBridgeXxx/setBridgeXxx` 范式，bridge 段含 permissionMode/receiptEnabled/richStreamingEnabled/mediaPublicBaseUrl | grill-me 拷问 4·A：扩 `bindings` 段，零新增 store |
| 持久化豁免 | `shared/persistence/store-registry.ts` 的 `user-preferences` defineStore + siteRule | 并入 user-preferences 后 census 已覆盖 |
| 能力守卫 | `server/routes/bridge.ts` 已 import `denyWithoutScope` / `denySecretMutationWithoutScope`（`server/http/capability-guard.ts`） | 绑定写入复用 |

## 1. 任务切分（按 spec 章节）

### T1 · 移动壳 tab 系统扩建（spec §2.1 / §3.1，决策 1·B + 1·A + 5·A）
- **落点**：`desktop/src/react/mobile/MobileApp.tsx` + 新增 `desktop/src/react/mobile/mobile-nav-slice.ts`（仿 `bridge-slice.ts` / `create-keyed-slice.ts` 范式）。
- **做法**：
  - 新增 `mobile-nav-slice`：state `activeTab: 'chat'|'channels'|'market'|'plugin'`，action `setActiveTab`；与桌面 `currentTab` 解耦（grill-me 拷问 1·A：移动壳自组页面状态）。
  - `MobileApp` 用 `useStore(s => s.mobileNav.activeTab)` 渲染对应复用组件：`ChatPage` / `MainContent` / `ChatSidebar` / `market` tab / `plugin:` tab（沿用现有复用）。
  - 底部固定 tab bar（4 项 + 设置入口）写在 `MobileApp.css`（grill-me 拷问 5·A：内聚，不抽全局断点）。
  - 左右滑切 tab 复用现有 `MOBILE_EDGE_GESTURE_*` 常量。
  - 复用组件对桌面态的防御已在 `mobile-init.ts` 注入 `false`，本任务核对 `ChatPage`/`MainContent` 在 `sidebarOpen:false` 下可渲染（grill-me 拷问 3·A 验证点）。
- **验收**：`MobileApp` 可切 4 个 tab；离线/边缘手势单测扩展于 `desktop/src/react/__tests__/mobile/MobileApp.test.tsx`。

### T2 · PWA 强化（spec §5.1，决策 6·A）
- **落点**：`desktop/src/react/mobile/mobile-init.ts`（SW 注册入口）、`mobile-main.tsx` 注册的 `./sw.js`（SW 文件由构建产出、供货于 `/mobile/sw.js`，不在源码树手写）、`desktop/src/mobile-manifest.webmanifest`（或 build 阶段改名复用 `manifest.webmanifest`）。
- **做法**：
  - 确认 SW 注册 scope：现状 `register("./sw.js")` 默认 scope = `/mobile/`，已满足 grill-me 拷问 6·A（SW 仅拦截 `/mobile*`）。**不强制加 `Service-Worker-Allowed`**（仅在要跨目录缩窄时才需）。
  - 强化 `mobile-manifest.webmanifest`：`display:standalone` / `start_url:/mobile` / `theme_color` / `icons`（含 maskable）。
  - `mobile-static.ts` 的 `safeRelativePath` 补白名单项 `mobile-manifest.webmanifest`（真实缺口）；或在 build 阶段把 manifest 命名为 `manifest.webmanifest`（白名单已含）。
  - `sw.js` 预缓存仅 `/mobile` 子树静态资产（`assets/`、`icons/`、`themes/`、`locales/`）+ 导航 fallback 回 `/mobile`。
  - VAPID **仅占位**：在 bridge 模块预留 `vapidPublicKey` 配置位与 `push` 事件监听骨架，决策 4·A 不接后端订阅表。
- **验收**：构建后 `/mobile` 离线打开 app shell 可用；DevTools → Application → Service Workers 确认 scope 仅 `/mobile/`；桌面壳 `/` 无 SW 拦截。

### T3 · Bridge 账号级 token 绑定（spec §4，决策 3·A + grill-me 拷问 2·A + 4·A）
- **T3.1 PreferencesManager 扩 bindings 段**
  - 落点：`core/preferences-manager.ts`。
  - 仿 `getBridgePermissionMode/setBridgePermissionMode` 范式，新增：
    - `getBridgeBindings(): BridgeBinding[]`
    - `upsertBridgeBinding(binding: { platform, tokenHash, defaultAgentId, createdAt })`（同 userId+platform 覆盖）
    - `removeBridgeBinding(platform)`
  - `BridgeBinding` 类型定义在 `core/preferences-manager.ts` 或 `lib/bridge/types.ts`。
  - token 明文不入磁盘：写入前 `maskSecretValue`（对齐 `shared/secret-custody.ts` 现有范式），落 `tokenHash`。
  - 零新增 store / 零新增 introspector（grill-me 拷问 4·A）。

- **T3.2 路由：新增账号级绑定端点**
  - 落点：`server/routes/bridge.ts` 的 `createBridgeRoute`。
  - 新增 `POST /api/bridge/bindings`（写：校验 `platform ∈ KNOWN_PLATFORMS`、token 非空、defaultAgentId 属该用户）→ 经 `denySecretMutationWithoutScope` 守卫 → `preferences.upsertBridgeBinding`。
  - 新增 `GET /api/bridge/bindings`（列出该用户绑定，token 不回明文）。
  - 新增 `DELETE /api/bridge/bindings/:platform`。
  - 入站 handler（bot webhook 入口）增加 token→userId 反查：优先从 `PreferencesManager.getBridgeBindings()` 按 `tokenHash` 匹配；命中则 `engineLifecycle.use(userId)` + 用 `defaultAgentId` 作为接待 agent，再走现有 `user-engine-middleware` 同构路径（grill-me 拷问 2·A：每账号每平台唯一 bot）。
  - 保留 `agent.config.bridge[platform].owner` 作为 agent 接待配置语义，仅归属权上移到账号级（spec §4.4）。

- **T3.3 设置 UI：账号绑定区块**
  - 落点：`desktop/src/react/settings/`（`bridge`-相关 tsx，复用现有 106 个 settings 组件之一或新增子组件）。
  - 桌面 + 移动设置页新增 "Bridge 账号绑定" 区块：platform 选择 + token 输入 + 默认 agent 下拉（来自该用户 agent 列表）。移动侧在 `MobileApp` 的设置入口挂载。
  - 复用 `denySecretMutationWithoutScope` / `denyWithoutScope` 守卫。

- **验收**：单测 `bridge_bindings` 解析（token→userId 反查 + `defaultAgentId` 回落）于 `server/routes/__tests__/` 或现有 bridge 测试；`PreferencesManager` 扩字段单测；bridge 入站回归测试覆盖 `engineLifecycle.use(userId)` 注入路径（仿 `server/routes/bridge.ts` 现有 test 范式，spec §6.2）。

### T4 · 持久化 / 构建校验（spec §6.3 / §6.4）
- 确认 `user-preferences` census 已覆盖 `bindings` 段（无新增 store，应自动通过 `scripts/scan-persistent-stores.mjs`）。
- 确认 `vite.config` / `scripts/build-server-runtime-assets.mjs` 把 `mobile.html` + `mobile-main.tsx` + `sw.js` + manifest 正确产出并随 `/mobile` 供货（spec §6.4 构建验证）。
- `vitest.config.js` 已 `testTimeout=30000`（M3 已调，复用）。

## 2. 执行顺序（依赖）
1. T1（移动壳 tab 扩建，独立，无后端依赖）
2. T2（PWA 强化，独立）
3. T3.1 → T3.2 → T3.3（后端先于 UI，UI 依赖后端端点）
4. T4（全量校验，最后）

## 3. 风险与已核实的真实缺口
- **manifest 供货白名单无缺口（已复核）**：`mobile.html` 引用 `./manifest.webmanifest`，`safeRelativePath` 白名单（server/routes/mobile-static.ts:148）已含 `manifest.webmanifest`；源码 `mobile-manifest.webmanifest` 经构建重命名为 `manifest.webmanifest` 产出，故**无需补白名单**。旧 plan 曾误判为缺口，已更正。
- **SW 实现已满足 T2**：`mobile-sw.js`（构建产出 `sw.js`）仅预缓存 `/mobile` 子树、`fetch` 跳过 `/api/` 与 `/ws`、网络优先回落缓存——app shell 离线可用且桌面壳 `/` 不受拦截，无需改 SW；默认 scope 即 `/mobile/`，`Service-Worker-Allowed` 头非必须。
- `ChatPage`/`MainContent` 在 `sidebarOpen:false` 下渲染需实测（T1 验收点）。
- bridge 入站 handler 改造需确认 webhook 入口具体函数名（在 `server/routes/bridge.ts` 或 `lib/bridge/inbound-*.ts`），T3.2 实施前用 code-explorer 再定位一次。

## 4. 提交策略
- 切特性分支 `feat/m4-mobile-pwa`（M3 教训：先分支再实施）。
- 每任务一个 commit，T4 校验通过后汇总，文档（spec + 本 plan）随首个 commit 一起提交。

## 5. 与 spec 的交叉核查（验收前对齐）
- **两壳功能集合一致性抽检（spec §6.2）**：T1 完成后手动/集成抽检桌面壳与移动壳在同一账号下 chat/channels/market/plugin 均可见——补入 T4 验收清单。
- **不重写 `SharingTab`**：M4 不动 `SharingTab.tsx`（M3 记忆 §9 已明确），移动壳仅在 tab bar 设"设置入口"，不在 SharingTab 加 M4 跳转。
- **SW 文件名以 `sw.js` 为准**（非 spec 旧写的 `mobile-sw.js`）；`Service-Worker-Allowed` 头非必须（默认 scope 已 `/mobile/`）。
