# openhanako Docker 部署（M5）

官方 Docker 化脚手架：`docker compose up --build` 即用。

## 文件

- `Dockerfile` — 多阶段构建镜像（builder 编译 native 模块 + 构建产物；runtime 精简运行）。
- `docker-compose.yml` — `hana` 服务 + 注释态 nginx 反代 + 关闭沙箱备选。
- `.env.example` — 环境变量模板，复制为 `.env` 填写。

## 快速启动

```bash
cd deploy
cp .env.example .env      # 填写 HANA_TOKEN（必填）、HANA_MASTER_KEY 等
docker compose up --build
# 访问 http://localhost:14500
```

数据持久化在 `./data`（挂载容器 `/app/data`，即 `HANA_HOME`）。

## 构建顺序铁律

`Dockerfile` 内**先 `build:renderer` 后 `build:server`**（对应 `scripts/build-server-runtime-assets.mjs:57` 断言）。
`build:server` 会把 `desktop/dist-renderer/` 拷入 `dist-server/linux-<arch>/desktop/dist-renderer`，
并由此构成容器内 `HANA_RENDERER_DIST`。若顺序反了，构建期断言失败。

## Renderer 路径

容器内 `HANA_RENDERER_DIST=/app/dist-server/linux-${TARGETARCH}/desktop/dist-renderer`
（`mobile-static.ts:31-38`：若该目录缺 `mobile.html` → 503 fail-fast）。**不要**改成默认
`desktop/dist-renderer`（容器内错位）。

## 沙箱（bwrap）安全声明 ⚠️

默认 `HANAKO_SANDBOX_BACKEND=bwrap`。容器内 bwrap 需要：

- `cap_add: [SYS_ADMIN]`
- `security_opt: [apparmor=unconfined]`
- 挂载 `/proc`

这会**显著削弱容器隔离边界**（近似宿主机权限），构成逃逸风险。仅受信任部署启用。

**关闭沙箱（纯 trusted-host）**：删除 compose 中 `hana` 的 `cap_add` / `security_opt` / `/proc` 挂载，
并设 `HANAKO_SANDBOX_BACKEND=host`。适用于单用户、受信任、不需工具沙箱隔离的场景。

## 环境变量（M5 四项能力）

| 变量 | 作用 | 对应里程碑能力 |
| :--- | :--- | :--- |
| `HANA_MASTER_KEY` | AES-256-GCM 加密 provider 凭据（任意长度口令，内部 SHA-256 派生） | §2.2 密钥静止加密 |
| `HANA_FALLBACK_MODEL` | 显式兜底模型 `provider/id`；解析失败启动期拒绝启用 | §2.4 兜底 failover |
| `HANA_FALLBACK_QUOTA_DAILY_TOKENS` | 兜底模型每日配额（按 userId） | §2.3 按用户限流 |
| `HANA_QUOTA_TZ` | 配额逻辑日时区（默认 UTC，04:00 起算） | §2.3 限流时区 |
| `HANA_TOKEN` | 客户端连接鉴权（必填） | 基础鉴权 |
| `HANAKO_SANDBOX_BACKEND` | `bwrap` / `host` | 沙箱 |

## 已知限制

- 配额累计为**单实例**前提（`HANA_QUOTA_TZ` 统一时区）；多实例部署下累计不准。
- 用户自添模型不受配额限制（决策 4：仅系统兜底通道受限）。
- failover 为单次切换（主→兜底即止），不自动回切主模型（决策 6）。
