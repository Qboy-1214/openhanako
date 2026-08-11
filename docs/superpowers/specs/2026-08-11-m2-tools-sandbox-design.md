# M2 设计规格（Spec）：工具与沙箱（含 M1 收尾）

> 本 spec 由 brainstorming 流程逐段确认（架构/组件/数据流/测试 4 段全部批准）。
> 上游依据：REARCHITECTURE.md ADR-4/7/10/14/15；M1 计划 `2026-08-10-m1-multiuser-isolation.md`。
> 范围决策：A 合并（P0 收尾 + M2-1/2/3 全套落地）；工作流重设计前端层（编译为 JS）+ 复用 lib/workflow 内核；
> Docker 形态代理决策 = 新增 docker.ts 作为 `createSandboxedTools` 的第四种 exec 后端（与 bwrap 平级），容器内部署自动回退 bwrap（见 §6.1）。
> 注：本 spec 经 grilling 技能完整拷问（7 分支），下列段落中的 **[GRILL]** 标记均为拷问后闭合的决策，与原初稿有实质修正。

---

## 1. 整体架构与边界

M2 = **M1 收尾（P0）× 工具与沙箱（M2-1/2/3）**，共用主轴：**"用户身份 → 隔离资源 → 沙箱执行"**。

**架构分层（自上而下）**
1. **路由层**（server/routes）：chat/desk 改为 F1 `getEngine(c)`，从 `principal.userId` 解析 per-user engine（P0-1/2/3）
2. **Sandbox 抽象层**（lib/sandbox）：`platform.ts` 动态选 exec 后端（docker/bwrap/win32/seatbelt），docker 作为 `createSandboxedTools` 的第四种 exec 后端（M2-3，路径 M：不新建 `SandboxOrchestrator` 类，复用现有 `spawnAndStream` 的 Pi SDK 契约）
3. **工具注册层**：用户脚本工具（M2-1，落盘 `users/<userId>/tools/`）与无代码工作流（M2-2，落盘 `users/<userId>/workflows/`）都经 `createSandboxedTools` 进入沙箱
4. **执行内核**：工作流复用 `lib/workflow/`（sandbox 钩子 + fan-out + journal + budget + watchdog），前端层编译为 JS 喂给现有 `runWorkflowScript`；用户脚本走 `createSandboxedTools` 的 exec 后端

**关键边界不变式**
- H1：每个 userId 有独立子目录 `users/<userId>/`，sandbox FS 只挂载属主子集（P0-4 + ADR-4/15）
- 跨用户边界：hub 事件 / desk / chat 一律按 ownerUserId 限定（P0-2）
- docker 执行后端只在裸机/VM 且有 daemon 时启用，容器内部署回退 bwrap（REARCHITECTURE §8.11.8）

---

## 2. 组件与接口

### P0 — M1 收尾

**P0-1 chat WS 首消息竞态**（`server/routes/chat.ts:1779` onMessage 回调 + `server/ws/engine-ws-binding.ts`）**[GRILL 路径 C]**
- **拦截点修正（关键）**：`@hono/node-ws` 的 `onMessage` 是 `upgradeWebSocket((c)=>({onOpen,onMessage}))` 的**框架回调方法**（chat.ts:1758-1786），**不是 `ws.on("message")` 事件监听**。因此"在 `bindEngineToWs` 内拦截 `ws.on('message')`"无法实现——`bindEngineToWs` 在 `onOpen` 调用（chat.ts:1775），但消息来自 `onMessage` 回调。
- **正确做法**：在 `chat.ts:1779` 的 `onMessage(event, ws)` 回调顶部加状态机——若 `ws.engine` 未就绪（`bindEngineToWs` 的 `lifecycle.use(userId)` 尚未 resolve），将解析后的 msg 入队 `ws._pending` 并返回；`bindEngineToWs` 的 `.then` 回调（`ws.engine`/`ws.hub` 就绪后）flush 队列逐条重入后续处理逻辑。**拦截点在 chat.ts onMessage，不在 bindEngineToWs 内**。
- **绝不回退全局 engine**：acquire 超时（如 5s）直接 `ws.close(1011)` 并记 warn，**不降级到全局兜底 engine**，以守住 per-user 隔离不变量。
- 接口不变（`bindEngineToWs` 仍 `(ws, lifecycle, ctx)`），队列 + 超时关闭落在 chat.ts onMessage 状态机。

**P0-2 hub 跨用户广播**（`server/routes/chat.ts:1092`）**[GRILL 方案 B + 实证修正]**
- `hub.subscribe` 仍保持**全局单订阅**（不改 hub 订阅维度）；`broadcast(msg)` 改造为 `broadcast(msg, { ownerUserId })`，仅对 `clients` 中 `record.userId === ownerUserId` 的 ws 发送（每个 ws record 在 onOpen 时由 `principal.userId` 写入 userId，方案 B 前提）。
- **ownerUserId 来源（实证修正）**：`ensureSessionRefForPath`（core/session-manifest/ref.ts:37）返回的 `SessionRef` 类型**只有 `sessionId/sessionPath/legacySessionPath`，无 `ownerUserId` 字段**（ref.ts:1-5）。因此"从 SessionRef 取 owner"不成立。
  - owner 应从 `sessionPath` 解析：`currentLocator.path` 形如 `users/<userId>/sessions/<id>`，userId 即路径段；复用 `getState(sessionPath)`（chat.ts:1122 已有）或 `sessionIdForPath` 反查。
- **[🔴 Step 0 必做]** 落实 owner 映射前，plan 须先确认 manifest 是否可靠携带 userId：若 `users/<userId>/` 前缀在 bridge/agent 会话等形态缺失，需**补写 userId 到 session-manifest**（或建 `sessionPath → userId` 独立索引供 hub 回调 O(1) 查），否则方案 B 的过滤前提不成立。该 Step 0 置于 P0-2 实现最前。
- 解析失败（无 owner）→ 按错误表丢弃 + warn（fail-closed，不误伤正常会话）。
- **[🟡 全局/系统事件处理]** 部分事件**没有 sessionPath**（如 `plugin_ui_changed`、`bridge_message`，见 `toNotificationWsMessage` chat.ts:294 `sessionPath` 缺省归一 null、`hardenStudio` line 549 `if(!msg.sessionPath) return msg`）。`broadcast(msg, { ownerUserId })` 在 **`ownerUserId` 为 undefined/null 时必须保持全局广播（不过滤、发给所有 ws）**——系统级事件本就无 owner 维度，错误过滤会丢弃合法系统事件。**实现者在 plan/注释里须显式标注此分支，防止把系统级事件误当作跨用户事件过滤掉。**

**P0-3 desk F1**（`server/routes/desk.ts` + `server/composition/full-root.ts`）
- `createDeskRoute(getEngine, hub)`：`const engine = getEngine(c)` 在每个 handler 顶部解析（沿用 M1 的 F1 模式）。
- 保留 M1 已加的 `isApprovedDir(dir, engine, {userId})` 纵深校验。

**P0-4 path-guard 参数化**（`lib/sandbox/path-guard.ts` + `lib/sandbox/policy.ts` + `lib/sandbox/index.ts`）**[GRILL 路径 E]**
- **不退役 `hanakoHome` 字段**（avoid 破坏 1249+ 处既有调用方与 desktop 契约）。`PathGuard.hanakoHome` 来自 `policy.hanakoHome`（path-guard.ts:56）。
- **[🟡 注入点指定]** "零改动"成立的前提：`createSandboxedTools` 内部构造 policy 时（index.ts:118 `makePolicy()`、line 177 `createManagedConfigWriteGuard({hanakoHome})`、line 185/212 等 `resolveHanaPiSdkManagedBinDir(hanakoHome)`），其传入的 `hanakoHome` 取值须改为 `userHome(userId)=path.join(baseDir,"users",userId)`（per-user engine）或保持 `baseDir`（全局兜底）。**即改动点在 `makePolicy()` 的 `hanakoHome` 来源，而非 PathGuard 类**。
- 隔离由"每个用户 engine 的 `hanakoHome` 指向自己子目录"天然达成，`path-guard.ts` 零改动、`policy.ts` 的 READ_ONLY/READ_WRITE 基准根自动限在该用户子目录内。
- `policy.ts` 新增"禁止读其他用户目录 / SystemDB"规则（REARCHITECTURE §8.8.6）——作为纵深防御，非根因（根因是 per-user `hanakoHome`）。

### M2 — 工具与沙箱

**M2-1 用户脚本工具**（`server/`、`lib/sandbox/`）**[GRILL 路径 G + 实证修正]**
- 存储：落盘 `users/<userId>/tools/<id>/{manifest.json, src}`，manifest = {name, paramSchema, runtime∈{js,ts,py,sh}}。**不设 `user_assets` 全局表**（该表在 codebase 不存在，属虚构）。
- 注册（实证）：`ToolCatalog.registerSource`（tool-catalog.ts:178）**真实存在且幂等**（`_sources.set(id,normalized)` + `_invalidate()`，重复调用覆盖；`replaceSource` 同义，line 187）。
- **[🟡 B origin 枚举确认步骤]** `ToolCatalogOrigin` 仅 `"mcp"|"builtin"`（line 23），且 **`tool-catalog.ts:162` 强制归一：`input.origin === "builtin" ? "builtin" : "mcp"`**——任何非 builtin 值（含设想的 `"user"`）会被**静默降级为 `"mcp"`**，走 `tool-catalog-bridge.ts:257/300` 的 MCP 调用分支（无对应 server → 调用失败/权限错配）。此外 `builtin` 路径经 `builtinCall` dispatch（line 302），与内置工具共享权限 voice。
  - **Plan Step 1 必做确认**：先查 `if (entry.origin === "builtin")` 的全部权限/可见性分支（engine.ts:2905 的 `deferredToolNames` 命名、tool-catalog-bridge.ts:257/300 的 invocation 路由、plugin-manager 的 `source==="builtin"` 信任链）——判定用户脚本复用 `"builtin"` 是否会错误继承内置工具权限级别。结论二选一：(a) 扩展 `ToolCatalogOrigin` 加 `"user"` 并补对应分支（推荐，语义正确、不污染 builtin 信任链）；(b) 复用 `"builtin"` 但需显式确认 `builtinCall` 能正确 dispatch 用户脚本 handler 且权限边界可接受。**无论选哪条，Plan 须先完成此确认再写注册代码，禁止直接写 `"user"` 后依赖 line 162 的静默降级。**
- **[🔴 注册时机修正]** 不能只在"engine 启动时注册"——否则新工具需重启 engine。**正确时机：engine acquire 完成后热注册**，并由 `POST /api/tools` handler 在落盘新工具后调 `catalog.replaceSource("user-scripts-<userId>", entries)` 增量刷新（registerSource 幂等，安全覆盖）；也可监听 `users/<userId>/tools/` 目录变更。运行时 handler 调 `createSandboxedTools` 的 exec 后端执行。**不走 plugin-runtime 的"安装式插件"打包流程**。

**M2-2 无代码工作流**（前端层 + 复用 `lib/workflow/`）**[GRILL 路径 J + 归属明确]**
- **[🟡 编译器归属明确]** 编译器（声明式 → JS）**归属服务端**：`POST /api/workflows` handler 接收前端编排 JSON → 在服务端编译为等价 JS（用 `agent()/parallel()/pipeline()` 全局函数表达）→ 落盘 `users/<userId>/workflows/<id>/script.js`。前端只负责编辑/提交 JSON，不生成 JS。
- 内核：`lib/workflow/` 零改动；运行时直接调现有 `runWorkflowScript(script)`，journal（续跑）/run-limits（budget/watchdog）全部继承。
- `workflow-tool.ts` 的 `execute()` 改为消费 `users/<userId>/workflows/<id>/script.js`，不再要求用户手写 JS。

**M2-3 Docker 执行后端**（`lib/sandbox/docker.ts` + `lib/sandbox/platform.ts`）**[GRILL 路径 M + 同构界定]**
- docker **仅作为 `createSandboxedTools` 的第四种 exec 后端**，不新建 `SandboxOrchestrator` 类（ADR-15 的 Orchestrator 属目标态，M2 由 `createSandboxedTools` 承载）。
- **[🟡 同构界定]** "同构"指**返回函数签名同构**：`(command, cwd, {onData, signal, timeout, env}) => Promise<{exitCode}>`，复用 `spawnAndStream` 的 Pi SDK 契约。但**构造参数比 `createBwrapExec(makePolicy(), {getExternalReadPaths, getSandboxNetworkEnabled})` 多** `image`（容器镜像）与 `additionalMounts`（额外挂卷，如密钥 tmpfs），即 `createDockerExec(policy, {getExternalReadPaths, getSandboxNetworkEnabled, image, additionalMounts})`。后端内部 `spawnAndStream("docker", ["run","--rm", image, "-v", ...mounts, "--network=none", "--memory=...","--cpus=...", "--", "/bin/bash", scriptPath], ...)`。
- 隔离表达：FS 仅挂 policy 允许路径（`-v`）；Network 默认 `--network=none`、声明才放行；限额 `--memory/--cpus` + 现有 timeout。
- `platform.ts` 新增 `docker` 分支（`makeSandboxExec` 平级接入），`HANAKO_SANDBOX_BACKEND`∈{auto,docker,bwrap} 选择（§6.1 逻辑，读取点见 §6.1）。

### 6.1 后端选择策略（避免 Docker-in-Docker 嵌套）**[GRILL 路径 O]**

执行沙盒（M2-3 的 docker 容器）与**应用部署容器**（M5 Dockerfile）是两层独立容器，不得盲目嵌套：

1. **裸金属 / VM 部署**（宿主有 docker daemon 且 `HANAKO_SANDBOX_BACKEND` 未禁用）→ 用 `createDockerExec` 容器化执行，强隔离。
2. **应用自身已在容器内运行**（M5 部署形态）→ 默认**回退 `bwrap`**，避免 Docker-in-Docker（DinD）。
   **检测算法（固化）**：`/.dockerenv` 存在 **OR** `/proc/1/cgroup` 含 `docker` **OR** `docker` CLI 不可用 → 判定为"容器内 / 无 daemon" → 回退 bwrap。
3. **显式覆盖**：`HANAKO_SANDBOX_BACKEND`∈{auto(默认), docker, bwrap} 强制锁定。
4. **读取点归属（M2-3 职责）**：`platform.ts` 顶部 `process.env.HANAKO_SANDBOX_BACKEND` 解析 + 上述检测算法实现，属 M2-3 范围；**不推给 M5**。
5. **跨里程碑待办（非 M2 范围，但须显式记录）**：`.env.example` 创建（含 `HANAKO_SANDBOX_BACKEND` 默认值与安全含义）、M5 `docker-compose.yml` 注入 `HANAKO_SANDBOX_BACKEND=bwrap`——这两项归 M5 部署 plan，本 spec 仅声明约束，不假装已存在。

> 原则：docker 执行后端只在"有 daemon 且不在容器内"时启用；容器内部署一律 bwrap，不要求 DinD，也不硬性失败。

---

## 3. 数据流与错误处理

### 数据流（端到端）

**用户脚本工具一次执行**
```
UI 定义工具(name/schema/runtime/src)
  → 落盘 users/<userId>/tools/<id>/{manifest.json, src}
  → engine acquire 后热注册（POST /api/tools 落盘后 replaceSource）→ catalog.registerSource("user-scripts-<userId>", entries)
调用工具
  → ToolCatalog 命中（user-scripts-<userId> source）→ createSandboxedTools({platform, userId, ...})
  → exec 后端执行（docker 后端起临时容器 / bwrap 回退 bwrap 进程）
  → stdout/stderr 回传 → 结果注入对话
```

**无代码工作流一次执行**
```
UI 拼装编排(内置工具+提示词+分支/循环)
  → POST /api/workflows（服务端编译为 JS）→ 存 users/<userId>/workflows/<id>/script.js
调用 workflow 工具
  → workflow-tool.execute() 读取 script.js
  → runWorkflowScript(script) 复用 lib/workflow/ 内核(fan-out/concurrency/journal/budget/watchdog)
  → 每个 agent() 节点经 createSandboxedTools 的 exec 后端进沙箱
  → 流式结果经 deferred store 回灌主对话
```

**P0 路径**：HTTP 请求 → `principal.userId` → `getEngine(c)` 取 per-user engine；WS → `bindEngineToWs` acquire + chat.ts onMessage 状态机（队列缓冲，绝不回退全局）→ `ws.engine`；hub 事件 → 由 `sessionPath` 解析 ownerUserId（`users/<userId>/` 前缀 / `getState`）→ `broadcast(msg,{ownerUserId})` 仅广播属主 WS（owner 映射可靠性依赖 P0-2 Step 0）。

### 错误处理

| 场景 | 处理 |
|---|---|
| P0-1 acquire 超时（5s） | `ws.close(1011)` + 记 warn，**不回退全局 engine**（守住隔离） |
| P0-2 跨用户 sessionPath 反查失败 | 解析无 owner（P0-2 Step 0 未覆盖的会话）→ 事件丢弃 + 记 warn（不广播） |
| P0-3 desk F1 解析失败 | 401/403（沿用 M1 鉴权） |
| P0-4 越界路径 | `PathGuardError` → 403（per-user `hanakoHome` 天然限域 + policy 纵深） |
| M2-1 脚本语法/运行错 | 捕获 → 返回 toolError，容器/进程销毁 |
| M2-1 沙箱越权 FS/Net | docker/bwrap 拒绝 → 上报拒绝原因 |
| M2-2 节点无进展 10min / 总时长 4h | watchdog/idle 触发 → abort → failWith（沿用现有 lib/workflow 内核） |
| M2-3 docker 不可用 / 在容器内（§6.1 检测） | 自动回退 bwrap（§6.1），不失败 |
| M2-3 容器资源超限 | 超时/oom → 终止容器 + 返回受限错误 |
| M2-3 密钥注入失败 | 不启动容器，返回配置错误 |

**不变量**：任何失败都 fail-closed——不降级到无沙箱执行、不跨用户泄漏、不静默吞错；P0-1 尤甚：宁可断连也不回退全局 engine。

---

## 4. 测试策略与验收

### 测试分层

**单元/集成测试（vitest，复用 M1 的 fake engine 注入模式）**
- `tests/path-guard-route.test.ts`：扩展 sandbox 用例（P0-4 跨用户路径拒绝、SystemDB 禁止读，验证 per-user `hanakoHome` 限域）
- `tests/route-getengine.test.ts`：扩展 desk（P0-3）的 F1 解析 + 多用户互不串号
- `tests/e2e/multiuser-server.test.ts`：扩展 P0-1（极速首消息不丢、acquire 超时关闭而非回退全局、**拦截点在 chat.ts onMessage 状态机而非 bindEngineToWs 内**）、P0-2（A 事件不出现在 B 连接，验证 `broadcast(msg,{ownerUserId})` + **P0-2 Step 0 owner 映射已建立**）
- `tests/session-manifest-owner.test.ts`（新增，P0-2 Step 0 验证）：manifest 可靠携带/可反查 userId；bridge/agent 会话形态下 owner 映射不缺失
- `tests/sandbox/docker-backend.test.ts`（新增）：`createDockerExec` 同构 `createBwrapExec` 签名；docker CLI 不可用 → 回退 bwrap；mock `HANAKO_SANDBOX_BACKEND` + `/.dockerenv` 检测
- `tests/tools/user-script.test.ts`（新增）：`users/<userId>/tools/` 落盘 → `registerSource` 注入 → exec 后端执行 + 越权拒绝
- `tests/workflow/nocode.test.ts`（新增）：前端层定义 → 编译为 JS → `runWorkflowScript` → 流式结果（验证内核零改动）

**真实执行测试（条件性）**
- docker 后端集成测试仅在 CI 标注 `HAS_DOCKER=1` 时跑（裸机环境）；容器内/无 daemon 自动跳过，靠 bwrap 回退集成测覆盖。

### 验收门槛
- `tsc` 全绿（无类型错误）
- `vitest` 全绿（M1 现有 16 + M2 新增全部通过）
- 端到端：两用户并发 → 各自 engine 隔离、事件不串、脚本工具进沙箱、工作流跑通（`lib/workflow` 内核复用）
- 部署态（docker 容器内）`HANAKO_SANDBOX_BACKEND=bwrap` 生效，不要求 DinD

### 范围边界（YAGNI）
- 不做分享市场（M3/ADR-16）、不做 Bridge 绑定（M5/ADR-9）、不做 UI 完整前端（仅工具/工作流的存储+注册+执行链路，UI 壳可最小）
- `lib/workflow/` 内核不重写（路径 J），仅前端层编译为 JS
- 不新建 `SandboxOrchestrator` 类（路径 M），docker 仅作 `createSandboxedTools` 第四种 exec 后端
- `.env.example` 与 M5 `docker-compose.yml` 注入 `HANAKO_SANDBOX_BACKEND` 属 M5 范围（路径 O 跨里程碑待办）
