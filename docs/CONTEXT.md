# CONTEXT.md — HanaAgent Web 多用户改造项目术语表

> 本文件是纯术语表（glossary），不含实现细节。术语随拷问逐步沉淀，最终决策见 `REARCHITECTURE.md`。

## 角色与身份

- **User（用户）**：经过登录认证的自然人账号。拥有自己的 LLM 供应商凭证（自带 Key+BaseURL）、模型选择、对话 session 列表、记忆、私有工具/技能/Agent。每个 User 对应**一个独立常驻的 HanaEngine 实例**（懒加载 + 空闲休眠）。
- **Agent（智能体）**：AI 角色（如"元/yuan"）。改造后"系统内置 Agent"与"用户自建 Agent"并存；内置可 fork 为私有副本。
- **Guest（访客）**：原 Hub 支持的未登录留言者，多用户化后废弃。

## 部署形态

- **Desktop（桌面版）**：改造目标中**要被移除**的形态（Electron + 本地 server 全部弃用）。
- **Web（网页版）**：改造后的统一前端——同一套 React 19 响应式应用，自适应桌面浏览器 + 移动端浏览器，叠加 PWA（manifest + Service Worker：离线缓存 / 加到主屏 / Web Push）。
- **Server（服务端）**：独立 Node.js 进程，承载全部引擎逻辑。对外暴露方式**双模态**：公网 HTTPS 域名（前方 Nginx/Caddy 反代）或内网隧道（frp/cloudflared），靠环境变量 `connectionKind` 切换。
- **HANA_HOME**：原单机数据根（`$HOME/.hanako`）。多用户化后降级为"部署根"，下设 `users/<userId>/` 子目录，每用户独立子目录 + 独立 SQLite 库。

## 数据与隔离

- **UserHome（用户数据根）**：`HANA_HOME/users/<userId>/`，含 `memory/`、`sessions/`、`tools/`、`plugins/`、`data.sqlite` 等。path-guard 根切换为该子目录，实现文件级隔离。
- **UserDB（用户数据库）**：每用户独立 SQLite 库（或统一库按 `user_id` 分区），存 session 元数据、用量统计、私有工具/技能/Agent 定义。
- **SystemDB（系统库）**：全局共享库，存账号表（密码哈希 / OIDC 主体）、兜底模型配置、分享市场索引。账号体系与用户数据分离。
- **Provider（供应商）**：LLM/媒体服务商。用户自带 Key + BaseURL（用户级）；用户还可**自填 OpenAI 兼容的兜底 provider+key+model**（缺失/超时/额度耗尽时回退，用户可选启用）。平台不预置兜底。
- **Session（对话）**：归属某 User，可在 PC/移动端通过同一后端同步。
- **Tool（工具）**：Agent 可调用能力。内置全局只读；用户可自建（脚本型 JS/TS/Python/Shell + 无代码工作流），自建工具强制 OS 级沙箱。用户私有工具可发布到 Sharing Market 供**同实例全员**安装（免审核，靠沙箱兜底安全）。
- **Skill（技能）**：知识包（SKILL.md + 脚本）。关系同 Tool：全局共享 + 可 fork 私有 + 可分享。
- **Plugin（插件）**：运行时扩展包，贡献 tools/routes/skills/UI。内置插件全局；用户插件私有。
- **Bridge（桥接）**：对接 Telegram/飞书/QQ/微信等外部 IM。多用户化后**保留并绑定到用户**（每用户配自己的 bot token）。

## 鉴权

- **Local Token（本地令牌）**：原桌面端 ↔ server 的 `server-info.json` 中的 SERVER_TOKEN，改造后弃用。
- **Account Auth（账号鉴权）**：用户登录体系——自建账号（用户名/邮箱 + 密码哈希）为主，**预留 OIDC 可插拔（仅留 `AuthProvider` 接口，首版不接厂商）**。登录发 HTTP-only session cookie；WebSocket 通过 `ws-ticket` 换票。
- **principal / scopes**：沿用现有权限原语，扩展 `userId` 维度。
- **Push（推送）**：首版仅应用内通知 + 可选前端轮询角标；Web Push 接口预留，不实现。
- **Account Deletion（账号注销）**：软删 30 天缓冲（可恢复）+ 超时硬删（物理清 UserHome+UserDB+Engine）；该用户发布的共享工具转系统内置。

## 执行安全

- **Sandbox（沙箱）**：用户自建脚本工具（JS/TS/Python/Shell）统一在 Docker 容器 / Seccomp 中执行，限制 FS（仅挂载该用户 UserHome 子集）、Network（默认禁，可显式放行）、CPU/内存/超时。内置/审核过工具走宽松策略。
- **Engine Lifecycle（引擎生命周期）**：管理每用户 Engine 实例的**懒加载 / 空闲休眠（默认 30min 无活动换出） / 热启 / 销毁**。小团队（<50 人）规模下的核心新增组件。

## 计费

- **不计费**：无订阅/支付。仅做基础用量统计（token、工具调用次数）支撑限流与配额，不收钱。
