# M0 Spec: 多用户 Web 骨架（去桌面）

> 来源：docs/REARCHITECTURE.md（ADR-1~17）+ brainstorming 收敛 + GRILL 拷问修正（见 §6）
> 范围：M0 去桌面骨架，方案 C（业务隔离 + 鉴权共享 + 注册闭环 + 前端路由化拆分）
> 部署：仅本地 dev 模式（`npm run dev:web`）
> ⚠️ GRILL 重大修正：原「每用户完整独立 HANA_HOME」模型已证伪（见 §6 Q11），改为 **A 模型：业务数据按用户隔离 + 鉴权/协调层 system 级共享**。

## 1. 范围与目标

### 目标
将 openhanako 从单用户 Electron 应用改造为可在本地 dev 模式运行的**多用户 Web 骨架**，完整验证四件事：
1. 每用户独立 Engine 实例（懒加载 + 空闲休眠，引用计数 + WS 静默计时）
2. 业务数据目录隔离（path-guard 防越权，仅外部路径输入边界）
3. 鉴权 / 协调层 system 级共享（账号表、session、授权、注册锁跨用户一致）
4. 前端路由化（为 PWA / 移动端打底）

### 隔离模型（GRILL Q11-A，唯一可行方案）
- **system 层（共享，所有用户可见）**：`users.json`（唯一账号总表）、`local-user-auth.json`（密码哈希）、`web-sessions.json`（登录会话，ws-ticket 跨请求校验依赖它）、`security/grants.json`、`server-node.json`、`data-epoch*`、`provider-catalog.json`（系统级兜底模型配置）。
- **user 层（隔离）**：`users/<userId>/` 下只放**业务数据** —— `agents/`、`sessions/`、`memory/`、`channels/`、`plugins/`（用户装的）、`skills/`、`user/preferences.json` 等。
- ❌ 禁止方案 B（每用户完整独立 HANA_HOME）：会把鉴权库也隔离进用户目录，导致 ws-ticket 跨用户失效、注册锁失效、系统级配置无处安放。

### 纳入（M0）
- 账号：注册、登录、登出（仅自建密码，scrypt-sha256；OIDC 仅留 `AuthProvider` 接口，不接厂商）
- 多用户隔离：每个 userId 拥有独立 `users/<userId>/` 业务 home + path-guard 根限制；鉴权类 store 指向共享 `system/`
- Engine 生命周期：按 userId 懒加载、引用计数 + WS 静默 30min `dispose()`、HTTP + WS 双通道注入（ADR-14/17 全量）
- 首用户自动标记 `SYSTEM_ADMIN`（ADR-4），并发注册加注册锁（GRILL Q7）
- 前端路由化：引入 `react-router-dom`，`main.tsx` 包 `<BrowserRouter>`，新增 `/login`，并把 App 内 chat/settings/agent 等视图拆为子路由
- 登录态：httpOnly cookie + 复用现有 ws-ticket（principal.userId 已含）

### 排除（M0 不做）
- 注销 / 删除账号（ADR-12 软删硬删留到 M1）
- Web Push / 后台推送（仅应用内，ADR-12）
- 分享市场（ADR-16，M1）
- 沙箱运行时（ADR-15，M1）
- Docker / 生产部署（仅 dev 模式）
- 计费 / 用量统计 UI（usage-ledger 数据层已存在，M0 不展示）

## 2. 目录结构与文件清单

### 新增后端
- `core/engine-lifecycle.ts` — `EngineLifecycle` 单例：`use / keepAlive / releaseRef / drainAll / activeCount / acquireCount(userId)`，持有 `Map<userId, UserEngineHandle>`；**引用计数**模型（GRILL Q4），空闲判定 = `refCount > 0 且 最近活动 > 30min`；内部 `setInterval` 每 60s 扫描静默超时的 handle → `dispose()`。
- `server/composition/user-engine-middleware.ts` — Express 中间件：解析 principal → `engineLifecycle.use(userId)`（acquire，refCount++）→ 注入 `req.engine`/`req.hub`；未登录 401；请求结束 `releaseRef(userId)`（refCount--）。
- `server/ws/engine-ws-binding.ts` — **WS 升级握手绑定 lifecycle（GRILL Q4 新增，原 spec 缺失）**：ws-auth ticket 带 userId → `engineLifecycle.use(userId)`（acquire）→ 挂 handle 到 ws ctx；`on message` → `keepAlive(userId)`（有往来续命）；`on close` → `releaseRef(userId)`。WS 是真正使用 Engine 的地方，必须走同一生命周期。
- `core/multiuser/paths.ts` — `userHomePath(userId)`（`users/<userId>`）/ `systemHomePath()`（`system/`）/ `assertWithinUserRoot(userId, p)`（path-guard，仅外部路径输入边界，见 §3）。
- `core/multiuser/engine-roots.ts` — 解析 `userDataRoot`（`users/<userId>/`）与 `systemRoot`（`system/`）双根；供 `use(userId)` 构造 engine 与 system 级 store 使用（GRILL Q11-A）。
- `core/multiuser/user-db.ts` — 业务数据分库工厂（复用 `store-registry`）：业务 store 的 baseDir 传 `userHomePath(userId)`；鉴权类 store（users.json / auth / sessions / grants）baseDir 传 `systemHomePath()`（GRILL Q9/Q11）。
- `server/auth/register.ts` — **改造 users.json 模型（GRILL Q2，非简单 append）**：从「单默认用户」改为「多用户无默认 / 首个注册者为 default + SYSTEM_ADMIN」；处理 `defaultUserId` 约束；建 `users/<userId>/` 业务 home；scrypt 哈希（复用 `local-user-account.ts`）；**加注册锁（GRILL Q7）：对 `system/users.json` 原子写/文件锁，并发抢首注册只有一个成功标 admin，其余降级普通用户**。
- `server/auth/session.ts` — httpOnly cookie 签发 / 校验（复用 ws-ticket 的 userId 载体），session 落在 `system/web-sessions.json`。

### 改动后端
- `core/engine.ts` — **支持双根（GRILL Q11-A 关键项，原 spec 漏）**：构造函数接受 `userDataRoot` 与 `systemRoot` 两个参数，业务数据按 `userDataRoot` 落盘，鉴权/协调类 store 按 `systemRoot` 落盘；移除「整台机器一个 HANA_HOME」假设。`dispose()` 已为实例级可逆释放（实测 line 2665，逐字段 dispose `_pluginManager/_mcp/_skills/_loopAlarm/_loopController/_agentMgr/_sessionCoord/computerRuntime/_sessionManifestStore/_studioCronService`），多实例安全。
- `server/composition/open-root.ts` — 删除启动期全局 `new HanaEngine()`，改注入 `engineLifecycle`（ADR-17）；仅初始化 `systemRoot`。
- `server/routes/web-auth.ts` — 加 `/api/auth/register`、`/api/auth/logout`，login 改写 cookie（session 落 system）。
- `server/index.ts`（line 437/477）— 移除全局 engine/hub 单例，改由中间件 / WS binding 按需提供。
- `server/http/route-security.ts` — `LOCAL_ONLY` → `SYSTEM_ADMIN` scope 分级（ADR-17）。

### 新增 / 改动前端（desktop/src/）
- `desktop/package.json` — 加 `react-router-dom` 依赖
- `react/router.tsx` — 路由表：`/login`、`/`（App 布局）、`/chat`、`/settings`、`/agents` 子路由
- `main.tsx` — 包 `<BrowserRouter>`，登录守卫
- `react/pages/LoginPage.tsx` — 复用 onboarding 样式
- `react/App.tsx` — 改为路由出口 `<Outlet/>`，原视图拆为 `react/pages/*`

### 验证
- `scripts/dev-web.js` 不变（已跑 server + Vite）
- 新增 `core/__tests__/engine-lifecycle.test.ts` 单测（含 A-dispose 后 B 仍正常，GRILL Q5）

## 3. 后端 Engine 生命周期与隔离契约

### EngineLifecycle（core/engine-lifecycle.ts）— 引用计数 + WS 静默计时模型（GRILL Q4 重写）
```ts
interface UserEngineHandle {
  userId: string;
  engine: HanaEngine;
  hub: Hub;
  refCount: number;            // HTTP+WS 引用计数；归零才开始计时空闲
  lastActivityAt: number;      // 最近一次有实际活动（含 WS 往来消息）
  state: 'starting' | 'ready' | 'draining' | 'disposed';
}

class EngineLifecycle {
  // acquire：refCount++；无 handle 则 new HanaEngine + await init + new Hub（GRILL Q5：必须重新 init）
  use(userId: string): Promise<UserEngineHandle>;
  keepAlive(userId: string): void;     // 更新 lastActivityAt；仅在有实际活动时调（HTTP 请求 / WS 往来消息）
  releaseRef(userId: string): Promise<void>; // refCount--；归零不立即 dispose，仅启动空闲计时
  drainAll(): Promise<void>;            // 进程退出时全部 dispose
  acquireCount(userId: string): number;
  activeCount(): number;                // 仅统计 state==='ready'
  // 内部：setInterval 每 60s 扫描 refCount>0 且 lastActivityAt>30min → release(hard)
}
```
- **生命周期单位 = 连接引用计数，不是 HTTP 请求**（GRILL Q4）。同一用户可能同时有 1 HTTP 请求 + 1 WS 连接，不能「HTTP 结束就 release」。
- **空闲口径（GRILL Q3 用户确认）**：WS 长连接挂着但无消息往来超时才算空闲。因此空闲判定 = `refCount > 0 且 lastActivityAt > 30min`，而非 refCount 归零（WS 一直挂着 ref 就不归零）。
- `use()` 重建必须 `new HanaEngine({ userDataRoot: userHomePath(userId), systemRoot: systemHomePath() })` + **`await engine.init(...)`** + `new Hub({ engine })`（GRILL Q5/Q6/Q8）。复用 `core/engine.ts` 的 `dispose()`（line 2665，实例级可逆）。
- **硬约束（GRILL Q6）**：`new HanaEngine` 的 `userDataRoot` 必须在 `use(userId)` 内由 `userHomePath(userId)` 动态计算，严禁误用进程级全局 `hanakoHome`。`systemRoot` 固定走 `systemHomePath()`。
- Hub 实例级强绑 engine（`hub/index.ts` line 70-71 / 97），可多开互不干扰；每用户 new Hub，不复用全局（GRILL Q8 已验证）。

### path-guard（core/multiuser/paths.ts）— 收紧到外部路径输入边界（GRILL Q10）
```ts
function userHomePath(userId: string): string;        // users/<userId>
function systemHomePath(): string;                    // system/
function assertWithinUserRoot(userId: string, p: string): void; // 越界抛 PathGuardError
```
- **范围收紧**：不在「所有 fs 读写」上包 guard（不现实，也留洞）。只在**接收 caller-selected 绝对路径的 API 边界**做校验 —— 即 `store-registry.ts` 中标注 `exemption: "writes an absolute path selected by the caller, outside any implied HANA_HOME"` 的入口（upload、desk workspace、file-ref、mount-aware、character-card 等，见 store-registry line 1377/1420 等）。
- 引擎内部路径（`agents/{agentId}/...`、`sessions/...` 等）已是相对 `userDataRoot` 的受管路径，不需逐个包 guard。
- `assertWithinUserRoot` 仅对上述外部路径输入调用，防跨用户越权（ADR-13 安全核心）。

### 路由中间件（server/composition/user-engine-middleware.ts）
```ts
function userEngineMiddleware(lifecycle: EngineLifecycle) {
  return async (req, res, next) => {
    const userId = req.principal?.userId;            // 来自 cookie/ws-ticket
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const handle = await lifecycle.use(userId);      // acquire，refCount++
    req.engine = handle.engine;
    req.hub = handle.hub;
    res.on('finish', () => lifecycle.releaseRef(userId)); // refCount--
    next();
  };
}
```

### WS 绑定（server/ws/engine-ws-binding.ts）— GRILL Q4 新增，原 spec 缺失
```ts
// ws upgrade：ws-auth ticket 带 userId
const handle = await lifecycle.use(userId);          // acquire，refCount++
ws.on('message', () => lifecycle.keepAlive(userId)); // 有往来续命
ws.on('close', () => lifecycle.releaseRef(userId));  // refCount--
```
- WS 是真正使用 Engine 的地方；不接 lifecycle 则 WS handler 拿不到按用户 engine（原 server 从全局闭包取，已废）。

### 业务/系统分库（core/multiuser/user-db.ts）— GRILL Q9/Q11 双根
- 业务 store（agents/sessions/memory/channels/plugins/skills 等）`baseDir = userHomePath(userId)`。
- 鉴权/协调 store（users.json / local-user-auth.json / web-sessions.json / security/grants.json / server-node.json / data-epoch / provider-catalog.json）`baseDir = systemHomePath()`，**全局共享单次**。
- `store-registry.ts` 本身以 `HANA_HOME` 为根设计（line 246/264），故 `use(userId)` 重建 engine 时按双根分别传入，而非整目录切换。

### scope 分级（server/http/route-security.ts）
- `LOCAL_ONLY` → `SYSTEM_ADMIN`；仅 `SYSTEM_ADMIN` 可访问系统级路由（如改 `system/provider-catalog.json` 兜底模型）。

## 4. 前端路由化与登录流

### 依赖
- `desktop/package.json` 新增 `react-router-dom`（v6）。

### 入口（main.tsx）
```tsx
import { BrowserRouter } from 'react-router-dom';
import { AppRouter } from './react/router';

createRoot(el).render(
  <BrowserRouter>
    <AppRouter />
  </BrowserRouter>
);
```

### 路由表（react/router.tsx）
```tsx
<Routes>
  <Route path="/login" element={<LoginPage />} />
  <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
    <Route path="/" element={<Navigate to="/chat" />} />
    <Route path="/chat" element={<ChatPage />} />
    <Route path="/agents" element={<AgentsPage />} />
    <Route path="/settings" element={<SettingsPage />} />
  </Route>
</Routes>
```
- `RequireAuth`：无登录 cookie → `<Navigate to="/login" />`（复用 `/api/auth/me` 探活）。

### App 改造（react/App.tsx → react/pages/*）
- 原 `App` 改为 `AppLayout`：保留侧边栏/顶栏，内容区用 `<Outlet/>`。
- 原内部视图拆为 `react/pages/ChatPage.tsx` / `AgentsPage.tsx` / `SettingsPage.tsx`，各自挂对应子路由。
- 其余 Electron-only 入口（onboarding/settings/mobile HTML）**不动**，仅 `main.tsx` 接 router。

### 登录页（react/pages/LoginPage.tsx）
- 复用现有 `onboarding` 样式与表单组件；含「注册」与「登录」两个 tab。
- 注册调 `POST /api/auth/register` → 自动登录；登录调 `POST /api/auth/login` → 写 httpOnly cookie → 跳 `/chat`。
- 登出：调 `POST /api/auth/logout` → 清 cookie → 回 `/login`。

### API base（dev 模式）
- 复用 `dev-web.js` 注入的 `HANA_DEV_WEB_API_BASE_URL`，前端 fetch 封装读取该变量，无需改代理配置。

### PWA 打底（仅预留）
- 现有 `mobile-manifest.webmanifest` / `mobile-sw.js` 保留；M0 不启用 Service Worker 注册，但路由结构已支持后续 SPA 化。

## 5. 验收清单与风险

### 验收清单（DoD）
1. `npm run dev:web` 启动后，访问前端 URL 自动跳转 `/login`。
2. 注册用户 A → 自动登录 → `users/<A>/` 业务 home 创建；`system/users.json` 记 A 且标 `SYSTEM_ADMIN`（首用户）；`system/local-user-auth.json` / `web-sessions.json` 在 system 层。
3. 注册用户 B（非管理员）→ 各自 `users/<B>/` 业务隔离；B 无法读取 A 的 `agents/` `sessions/`（path-guard 单测覆盖外部路径边界）。
4. A、B 同时在线，各自独立 Engine 实例（`activeCount() >= 2`，各自 `userDataRoot` 不同）；A 空闲 30min 后 `dispose()` 释放，再次访问重新 `new+init+new Hub` 懒加载且业务数据不丢。
5. **A 的 engine `dispose()` 后，B 的 engine 仍正常工作**（GRILL Q5 单测，验证 dispose 不杀全局资源）。
6. **并发抢首注册**：两个请求同时注册，只有一人成 `SYSTEM_ADMIN`，另一人降级普通（GRILL Q7 注册锁，文件锁/原子写验证）。
7. 登出后 cookie 清除，session 从 `system/web-sessions.json` 移除，访问 `/chat` 重定向回 `/login`。
8. 单测 `core/__tests__/engine-lifecycle.test.ts`：acquire/refCount 复用/releaseRef 不立即 dispose/keepAlive 续命/静默 30min 后 dispose/drainAll/A-dispose-B-正常 全绿；`paths.ts` `assertWithinUserRoot` 越界抛错。

### 风险与缓解
- R1：`open-root.ts` 全局 engine 被广泛引用 → grep 全部引用点，改从 `req.engine` / WS ctx 取，回归现有 server 测试。
- R2：前端多 entry 与 router 共存冲突 → 仅 `main.tsx` 接 router，其余 entry 不变。
- R3：cookie 在 dev 跨 Vite 与 server 端口同源问题 → 复用 `HANA_DEV_WEB_*` 代理，cookie domain 设 `127.0.0.1`，session 落 `system/` 共享。
- R4：scrypt 注册与 `local-user-account.ts` 重复 → 直接复用，不另写哈希。
- **R5（GRILL Q11）**：`core/engine.ts` 双根改造风险高（原假设单 HANA_HOME）→ 先小步改 home 解析支持 `userDataRoot`/`systemRoot`，写单测验证业务库与鉴权库分落；回归现有单用户模式（single-user 时 `userDataRoot===systemRoot` 退化为旧行为）。
- **R6（GRILL Q4）**：WS 引用计数与 HTTP 引用计数错配导致提前 dispose → `engine-ws-binding.ts` 与中间件都走同一 `use/releaseRef`，单测覆盖「WS 挂着、HTTP 结束」场景 engine 不回收。
- **R7（GRILL Q5）**：`dispose()` 若某子服务是全局单例停摆会互杀 → 已确认 cron/loop 等为实例字段，风险低；用 DoD-5 单测固化。

### 不在 M0 验证
生产部署、分享市场、沙箱、推送、注销删除 —— 留待 M1。

---

## 6. GRILL 拷问记录（spec 修正来源）

本轮 spec 经 grill-me skill 逐条拷问，发现多处「假设当事实」的错误，已全部修正：

| # | 拷问点 | 结论 / 修正 |
|---|--------|------------|
| Q1 | `HanaEngine` 能否多实例 | 可多实例；cron/loop 为实例字段，无全局单例。补单测 A-dispose 后 B 正常 |
| Q2 | 现状是否真实多用户 | 现状为「单默认用户」模型，`getDefaultUser` 强制 `defaultUserId`；`register.ts` 须改模型非 append |
| Q3 | 30min 空闲定义 | 用户确认：WS 长连接无消息往来超时才算空闲 → 空闲口径改 `refCount>0 且 lastActivityAt>30min` |
| Q4 | WS 如何接 EngineLifecycle | 原 spec 缺失 WS 通道；改为引用计数模型 + 新增 `ws/engine-ws-binding.ts` |
| Q5 | `dispose()` 可逆性 | 可逆（实例级逐字段 dispose）；`use()` 重建必须 `new+init+new Hub` |
| Q6 | `hanakoHome` 动态化 | 补硬约束：`use(userId)` 内 `userHomePath(userId)` 动态传入，禁全局误用 |
| Q7 | 首用户注册竞态 | 加注册锁（原子写/文件锁），并发抢首注册仅一人成 admin |
| Q8 | `Hub` 多实例语义 | Hub 实例级强绑 engine，可多开；每用户 new Hub，不必改单 Hub 路由 |
| Q9 | store-registry 分库根 | 全层以 HANA_HOME 为根；无「全局库 vs 用户库」二分 → 引出 Q11 双根模型 |
| Q10 | path-guard 范围 | 原「所有读写」不现实；收紧到「caller-selected 绝对路径 API 边界」 |
| Q11 | 隔离边界 A vs B | 选 **A**：业务数据隔离 + 鉴权/协调 system 级共享；B 会导致 ws-ticket/注册锁/系统配置全废，不可行 |
