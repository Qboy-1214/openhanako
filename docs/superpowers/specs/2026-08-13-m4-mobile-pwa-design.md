# M4 · 移动端 / PWA / Bridge 绑定用户 — 设计文档

> 规划日期：2026-08-13
> 上游方案：docs/REARCHITECTURE.md（里程碑 M4：移动/PWA + Web Push + Bridge 绑定用户）
> 方法：brainstorming skill，已与用户逐项确认核心决策（见 §0 决策记录）。
> 状态：设计阶段（design）。本文件经用户审阅后，将转入 writing-plans 生成实现 plan。

---

## 0. 决策记录（已与用户确认）

通过 Visual Companion 逐屏确认，M4 五项核心决策如下：

| # | 议题 | 决策 | 说明 |
|---|------|------|------|
| 1 | 桌面/移动 UI 拆分 | **B · 独立移动壳** | 扩建现有 `MobileApp` 为独立移动前台，非单纯 @media |
| 2 | 移动壳状态层 | **② 抽取移动切片 store** | 沿用现有 slice 架构，新增移动专属 slice，复用业务组件 |
| 3 | Bridge 绑定模型 | **A · 账号级 token→userId** | 用户设置页填 token，绑定到服务端账号，入站反查 userId |
| 4 | Web Push | **A · 跳过** | 仅应用内通知 + SW 静态缓存 + VAPID 占位，零后端订阅表 |
| 5 | 响应式基线 | **A · 单断点移动优先** | `<768px` 单列 + 底部 tab bar；桌面壳继续 `≥768px` 侧栏 |

**数据与代码边界澄清（用户关键疑问）**：用户数据（sessions / skills / tools / workflows）隔离边界在**后端**——per-user Engine（`core/engine-lifecycle.ts`）+ `users/<userId>/` 目录。前端方案①②③在**数据层面完全等价、都安全**，不存在"移动端独立导致数据隔离"的风险。三种方案区别仅在前端代码组织。

---

## 1. 现状盘点（真实代码底数）

通过 code-explorer 子代理核实，避免像 M3 plan 那样基于虚构符号设计：

### 1.1 已落地（M0–M3）
- 多用户隔离：`server/engine-lifecycle.ts` + `server/composition/user-engine-middleware.ts`（缺失 principal → 401，注入 `c.get("engine")`/`c.get("hub")`）。
- 多账号：`server/auth/register.ts`、`unregister.ts`（register/unregister 流程）。
- 每用户脚本/工作流/沙箱：`core/engine.ts`（`registerUserScript`/`buildTools`/`createSandboxedTools`）、`lib/sandbox/`。
- 分享市场：`server/sharing/store.ts`（`SharingAssetStore`）+ `server/sharing/index.ts`（`SharingMarket`）+ `shared/persistence/store-registry.ts` 的 `shared-assets-sqlite`。

### 1.2 M4 骨架已存在（非从零）
- PWA：`desktop/src/mobile-main.tsx`（注册 `./sw.js`，**真实 SW 文件名是 `sw.js`，非 `mobile-sw.js`**；SW 文件由构建产出、供货于 `/mobile/sw.js`，不在源码树手写）、`desktop/src/mobile-manifest.webmanifest`。
- 移动壳：`desktop/src/react/mobile/MobileApp.tsx`（**独立组件树 + 独立 CSS + 独立 Vite entry**，非桌面别名）。
- 路由：`server/routes/mobile-static.ts`（`decideMobileStaticRouteOptions`）+ `server/composition/open-root.ts` 挂载 `/mobile`。
- 现有 MobileApp 事实：import `useStore` from `../stores`（**桌面全局 store**），且**只渲染 chat tab**，无 channels/market/plugin 入口。已含边缘手势常量（`MOBILE_EDGE_GESTURE_*`）。
- store 体系：slice 架构（`desktop/src/react/stores/create-keyed-slice.ts` + 各 `*-slice.ts`，含 `bridge-slice.ts`）。
- Bridge：`server/routes/bridge.ts`（`createBridgeRoute`），owner 经 `resolveBridgeOwnerUserId({platform, agent, index})` 取自 **agent.config.bridge[platform].owner**——即绑定在 **agent 级**，非账号级。

### 1.3 真实缺口（M4 需新建）
- 账号级 Bridge 绑定（token→userId 反查 + 绑定落库 + 设置 UI）。
- 真·Web Push（zero）：确认跳过，但需保留占位。
- 移动壳导航补全（channels/market/plugin 入口 + 底部 tab bar）。
- 移动专属 slice（activeTab / 移动会话 / push 占位）。
- 响应式断点规范化（`<768px` 单列基线）。

---

## 2. 设计 §2.1 · 移动壳状态层（决策 2）

### 目标
把 `MobileApp` 从"直接读桌面全局 `useStore`"改为"读移动专属 slice"，复用业务组件但剥离桌面概念（`sidebarOpen`/`jianOpen` 等）。

### 落点（遵循真实 slice 范式）
- 新增 `desktop/src/react/stores/mobile-nav-slice.ts`（仿 `bridge-slice.ts` / `create-keyed-slice.ts`）：
  - state：`activeTab: 'chat' | 'channels' | 'market' | 'plugin' | 'settings'`，`pushToken: string | null`，`offlineReady: boolean`。
  - actions：`setMobileActiveTab`、`setPushToken`、`setOfflineReady`。
- `MobileApp.tsx` 中将 `useStore(s => s.currentTab …)` 等桌面域读取改为 `useStore(s => s.mobileNav.activeTab)`（具体字段名在实现期按新建 slice 确认）。
- **保留复用**：`ChatPage` / `MainContent` / `ChatSidebar` / `SharingTab`/`market` tab / `plugin:` tab 等桌面业务组件继续被 MobileApp 引用——这是决策 2 相比决策 3 的核心红利（见 §0 澄清）。
- **组件内桌面态判空（grill-me 拷问 3·A）**：复用的桌面组件对 `sidebarOpen` / `jianOpen` / `currentTab` 等桌面域 state 一律走 `?? default` 防御分支（如 `sidebarOpen ?? false`），MobileApp 不注入这些桌面态、只传移动需要的 props。被复用组件需验证在"无 sidebar"条件下可正常渲染（`ChatPage`/`MainContent` 为高风险验证点）。不抽 `MobileXxx` 包装层、不复写双实现，以保留复用红利。

### 不做
- 不新建独立 store 实例（不引入第二套 Zustand root）；只新增 slice。
- 不复制/重写 ChatPage/MainContent/MarketPage（避免双倍维护与 M2/M3 功能漂移）。

---

## 3. 设计 §2.2 · 移动壳导航与响应式（决策 1 + 5）

### 3.1 底部 tab bar（决策 5，grill-me 拷问 5·A：移动壳自有 CSS 内聚）
- `<768px` 规则**全部内聚在 `MobileApp.css`（移动壳自有 CSS）**：单列布局 + 固定底部 tab bar，导航项：`chat` / `channels` / `market` / `plugin`（+ 设置入口）。
- 复用现有 `MOBILE_EDGE_GESTURE_*` 边缘手势（已在 MobileApp 内）：左右滑切相邻 tab。
- notch 安全区适配（`env(safe-area-inset-bottom)` / `safe-area-inset-top`）写在 `MobileApp.css`，不抽全局断点 token、不做运行时 `matchMedia` 判断（`/mobile` 路由已限定移动供货场景）。
- 桌面壳**完全不感知**移动断点，零改动。

### 3.2 桌面壳对照
- 桌面壳（`main.tsx` / `App.tsx`）继续服务 `≥768px`，侧栏 tabs（chat/channels/market + 动态 plugin:）。两壳断点清晰，互不侵入；响应式规则各居其壳（grill-me 拷问 5·A，无共享断点变量）。

### 3.3 现有桌面 tabs 对齐
- 当前 `currentTab` 体系：`chat` / `channels` / `market`（+ 动态 `plugin:`）。MobileApp 的 `activeTab` 必须与之一致，保证"同一账号在桌面/手机看到的功能集合相同"（数据等价验证点）。

---

## 4. 设计 §2.3 · 账号级 Bridge 绑定（决策 3，ADR-9 落地）

### 4.1 现状问题
`resolveBridgeOwnerUserId` 从 `agent.config.bridge[platform].owner` 取 owner——绑定在 **agent** 上。换 agent 需重绑；且非"服务端账号"语义。

### 4.2 目标模型
- 用户在**自己的设置页**填写平台 bot token（Telegram/飞书/QQ/钉钉/微信）。
- token 绑定到该用户的**服务端账号**（`userId`），落库于用户域——复用既有 `core/preferences-manager.ts` 的 `user-preferences` store（`preferences.json` 的 `bridge` 段，而非独立表；见 §4.3 与 grill-me 拷问 4·A）。
- **每账号每平台唯一 bot（grill-me 拷问 2·A）**：一个 userId 在同一 platform 下只绑定一个 token；重复绑定等同更新。绑定记录带 `defaultAgentId`——平台入站消息若无显式 agent 指定，回落到该默认 agent 接待（M4 不开放"每平台多 agent"选择，决策 C 留作后续）。
- 入站消息：经 token → 反查 `userId` → 读 `defaultAgentId` → `engineLifecycle.use(userId)` 注入该用户 Engine → 走现有 `user-engine-middleware` 同构路径。

### 4.3 落点建议（grill-me 拷问 4·A：并入 `user-preferences`）
- **不复用独立表 / 不复用独立 sqlite store**：直接扩展既有 `core/preferences-manager.ts` 的 `user-preferences`（`preferences.json`）——在现有 `bridge` 段内新增 `bindings: [{ platform, tokenHash, defaultAgentId, createdAt }]` 数组。token 以 hash 落库（`maskSecretValue` 范式），明文不入磁盘；`defaultAgentId` 指向该用户域内某 agent，缺失时回落到该用户默认 agent。
- **零新增持久化工序**：沿用既有 `user-preferences` 的 `defineStore` + siteRule（`store-registry.ts` 已注册），census 已覆盖；无需补 sqlite introspector / 重生成 fingerprint（规避 M3 踩过的坑）。
- `server/routes/bridge.ts`：`createBridgeRoute` 增加"按 userId 读取 `preferences.bridge.bindings`"分支；入站 handler 增加 token→userId 反查（`PreferencesManager` 提供 `getBridgeBindings()` / `upsertBridgeBinding()` / `removeBridgeBinding()`，仿现有 `getBridgePermissionMode` 范式）；解析结果附带 `defaultAgentId` 作为接待 agent。
- 设置 UI：在桌面 + 移动设置页新增 "Bridge 账号绑定" 区块（复用现有 `settings/` 体系，106 个 tsx）；绑定表单含 platform 选择 + token 输入 + 默认 agent 选择（下拉来自该用户 agent 列表）。
- 校验：绑定写入走现有 `denyWithoutScope` / `denySecretMutationWithoutScope` 能力守卫（`server/routes/bridge.ts` 已 import）。

### 4.4 与现有 agent 级 owner 的关系
- 保留 agent.config.bridge 作为"agent 接待配置"（哪个 agent 处理该平台），但**归属权**上移到账号级 token 绑定。形成"token 归账号 → 账号下指定默认 agent 接待"的双层语义（grill-me 拷问 2·A：每账号每平台唯一 bot，`defaultAgentId` 即接待落点）。M4 只落地账号归属 + 默认 agent，不开放"每平台多 agent"选择（决策 C 留作后续）。

---

## 5. 设计 §2.4 · PWA / Web Push（决策 4）

### 5.1 做
- 强化现有 `mobile-manifest.webmanifest`：`name`/`short_name`/`icons`/`display:standalone`/`start_url:/mobile`/`theme_color`。
- **SW scope 限定 `/mobile/`（grill-me 拷问 6·A）**：`mobile-main.tsx` 经 `mobile-init.ts` 注册 `./sw.js`（**真实文件名是 `sw.js`，非 `mobile-sw.js`**），默认 scope 已落在 `/mobile/` 下（注册 URL 在 `mobile.html` 上下文）——**无需 `Service-Worker-Allowed` 头**（仅当要跨目录缩窄 scope 时才需）。SW 只拦截 `/mobile*` 请求，导航 fallback 只回退到 `/mobile` app shell，桌面壳 `/` 零触达、零风险。
- 强化 `sw.js`：静态资源预缓存（**仅 `/mobile` 子树内的 JS/CSS/icon**，app shell 离线可用）+ 导航 fallback（回 `/mobile`）；保留 `hana-mobile-update-available` / `hana-mobile-apply-update` 事件钩子（MobileApp 已监听）。
- 应用内通知：复用 `ToastContainer` / `toast-slice.ts` 做网页打开时的提醒（角标/横幅）。
- **VAPID 占位**：在 bridge 或独立模块预留 `vapidPublicKey` 配置位与 `push` 事件监听骨架，但不接后端订阅表。

### 5.2 不做（ADR-12.3 首版）
- 不实现 VAPID 密钥签发/轮换。
- 不新增 `push_subscriptions` 表、订阅端点、服务端 dispatch。
- 离线时不推送真实通知（仅应用内）。

---

## 6. 验证计划

### 6.1 类型 / 单元
- `desktop/src/react/__tests__/mobile/MobileApp.test.tsx` 扩展：断言 `activeTab` 切 tab、边缘手势、离线事件；并断言 `ChatPage`/`MainContent` 在**不注入桌面态**下可挂载渲染（grill-me 拷问 3·A 验证点）。
- 新增 `bridge_bindings` 解析单测（token→userId 反查 + `defaultAgentId` 回落）。

### 6.2 集成
- `engineLifecycle.use(userId)` 注入路径在 bridge 入站回归测试（仿 `server/routes/bridge.ts` 现有 test 范式）。
- 桌面/移动两壳在同一账号下功能集合一致性抽检（chat/channels/market/plugin 均可见）。

### 6.3 持久化基线（grill-me 拷问 4·A：并入 user-preferences，零新增 store）
- `bridge` 绑定数据并入既有 `user-preferences` store（`preferences.json` 的 `bridge.bindings` 段），**不新增 `defineStore`**、不新增 sqlite——census 已由 `user-preferences` 既有 siteRule 覆盖，`scripts/scan-persistent-stores.mjs` 不受影响。
- **无需**补 `generate-persistence-schema-fingerprint.mjs` introspector / 重生成 fingerprint（区别于 M3 `shared-assets-sqlite` 的独立 sqlite 路径）。
- 注：manifest / sw 是 **HTTP 供货静态资源**，与 persistence siteRule 豁免（磁盘写审计）无关——供货白名单在 `server/routes/mobile-static.ts` 的 `safeRelativePath`，不在此处。
- 风险点：单 JSON 写放大（每次 bridge 改动重写整份 preferences）；token 安全靠 hash，JSON 备份同步导出风险略高于 sqlite 0600——M4 接受，后续如需每平台多 bot / 复杂查询再升级为独立 sqlite（决策 C 演进路径）。

### 6.4 构建
- 确认 `vite.config` / `scripts/build-server-runtime-assets.mjs` 将 `mobile.html` + `mobile-main.tsx` + `sw.js` + `mobile-manifest.webmanifest`（或复用 `manifest.webmanifest`）正确产出并随 `/mobile` 路由供货。MobileApp 扩建后需重新验证构建 entry。
- **SW scope 验证（grill-me 拷问 6·A）**：`mobile-main.tsx` 经 `mobile-init.ts` 注册 `./sw.js`，默认 scope 即 `/mobile/`（**无需 `Service-Worker-Allowed` 头**）；离线打开 `/mobile` 验证 app shell 可用、桌面壳 `/` 不受 SW 拦截（DevTools → Application → Service Workers 确认 scope 仅 `/mobile/`）。
- **供货白名单真实缺口**：`mobile-static.ts` 的 `safeRelativePath` 白名单含 `sw.js` / `manifest.webmanifest`，但**不含 `mobile-manifest.webmanifest`**——T2 须补白名单，或将 manifest 命名为 `manifest.webmanifest`（白名单已含）。

---

## 7. 偏差与开放项

- **决策 3 的 agent 选择**：M4 落地 A（账号归属），agent 接待沿用现状；若需"每平台选不同 agent"（决策 C）留作后续。
- **slice 字段命名**：`mobile-nav-slice.ts` 具体 state/action 名实现期按 `create-keyed-slice` 范式最终确认（文档不预占虚构符号）。
- **bridge 落库形态（已定·grill-me 拷问 4·A）**：并入 `user-preferences`（`preferences.json` 的 `bridge.bindings` 段），不新增独立表 / 独立 sqlite store。原"bridge_bindings 表名"开放项关闭。
- **Web Push 完整版**：明确 out-of-scope（ADR-12.3），仅留 VAPID 占位。

---

## 8. 范围外（out-of-scope）
- M5 部署/Docker（独立里程碑）。
- 完整 Web Push 后端（决策 4 跳过）。
- 平板/桌面多断点收敛（决策 5 选单断点）。
- Bridge 决策 C 的 agent 选择层（留作增强）。
