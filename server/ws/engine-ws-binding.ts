import type { WebSocket } from "@hono/node-ws";
import { readAuthPrincipal } from "../http/capability-guard.ts";

/**
 * WebSocket 升级握手绑定 EngineLifecycle（GRILL Q4 新增，原 spec 缺失）。
 *
 * WS 是真正使用 Engine 的地方。ws-auth ticket 带 userId → lifecycle.use(userId)
 * （acquire）→ 挂 handle 到 ws ctx；on message → keepAlive（有往来续命）；
 * on close → releaseRef（refCount--）。WS 与 HTTP 共用同一生命周期，避免
 * 「HTTP 结束就 release」导致 WS 长连接期间引擎被回收。
 *
 * M0 作为机制接缝；全量 WS 路由接管推迟到 M1。
 */
export function bindEngineToWs(ws: any, lifecycle: any, ctx: any): void {
  const principal: any = readAuthPrincipal(ctx as any) ?? ws.principal;
  const userId = principal?.userId;
  if (!userId) {
    ws.close(1008, "unauthenticated");
    return;
  }
  // acquire 绑定到该连接
  lifecycle
    .use(userId)
    .then((handle: any) => {
      ws.engine = handle.engine;
      ws.hub = handle.hub;
      ws.on("message", () => lifecycle.keepAlive(userId));
      ws.on("close", () => lifecycle.releaseRef(userId));
    })
    .catch((e: any) => {
      ws.close(1011, e?.message || "engine_acquire_failed");
    });
}
