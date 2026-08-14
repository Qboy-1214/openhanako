# syntax=docker/dockerfile:1
#
# openhanako — M5 官方 Docker 化脚手架（多阶段构建镜像）
#
# 顺序铁律（见 scripts/build-server.mjs + scripts/build-server-runtime-assets.mjs:57）：
#   必须先 npm run build:renderer（产出 desktop/dist-renderer/）再 npm run build:server
#   （把 renderer 拷入 dist-server/linux-<arch>/desktop/dist-renderer）。反向会断言失败。
#
# 容器内 renderer 产物路径必须显式命中（server/routes/mobile-static.ts:31-38）：
#   若 HANA_RENDERER_DIST 指向的目录缺 mobile.html → 503 fail-fast。
#   故用 ARG TARGETARCH 拼出真实拷贝路径，绝不能用默认 desktop/dist-renderer（错位）。

# ── 阶段 1：builder ────────────────────────────────────────────────
FROM node:24-bookworm AS builder

# native 编译工具链：better-sqlite3 / node-pty / @node-rs/jieba 在容器内需要
# 原生编译（g++/make/python3）；jieba 走预编译二进制，无需 rust 目标。
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存），再拷贝源码
COPY package.json package-lock.json* ./
COPY packages ./packages
RUN npm ci

# 拷贝其余源码（build 脚本与 server 入口）
COPY . .

# 构建顺序硬约束：先 renderer 后 server
RUN npm run build:renderer \
    && npm run build:server

# ── 阶段 2：runtime ───────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# bubblewrap：lib/sandbox/index.ts:353-362 在 bwrap 不可用时 fail-closed（不回退 host）。
# 启用沙箱（HANAKO_SANDBOX_BACKEND=bwrap）必须装好 bwrap，否则所有 bash 工具被拒。
# 安全警示：bwrap 在容器内需 SYS_ADMIN + apparmor=unconfined，会削弱隔离（见 compose 注释）。
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# 仅拷运行所需：源码（Node 24 原生剥离 TS 直接跑 server/main-full.ts）、
# node_modules、build 产物（dist-server 内含 renderer）。
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/core ./core
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/cli ./cli
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json* ./

# renderer 产物真实路径（对应 build-server.mjs 拷贝规则）
ARG TARGETARCH
ENV HANA_RENDERER_DIST=/app/dist-server/linux-${TARGETARCH}/desktop/dist-renderer

# 服务端口 / 沙箱后端（bwrap 容器内方案 X）
ENV HANA_PORT=14500
ENV HANAKO_SANDBOX_BACKEND=bwrap

EXPOSE 14500

# 直接用 Node 24 原生 TS 剥离运行 server 入口（等价于 npm run server）
CMD ["node", "server/main-full.ts"]
