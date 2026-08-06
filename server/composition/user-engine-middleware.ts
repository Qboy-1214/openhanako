import type { Context } from "hono";
import { readAuthPrincipal } from "../http/capability-guard.ts";

/**
 * 每请求引擎中间件（GRILL Q4）。
 * 从 principal 取 userId，向 EngineLifecycle acquire 一个按用户 engine/hub，
 * 注入到 c.get('engine')/c.get('hub')；请求结束后 releaseRef（只释放一次）。
 *
 * 注意：M0 中该中间件作为「按用户引擎」机制的演示与可用接缝；
 * 全量路由接管（替换全局兜底 engine）推迟到 M1（见 plan 已知边界）。
 */
export function userEngineMiddleware(lifecycle: any) {
  return async (c: Context, next: () => Promise<void>) => {
    const principal: any = readAuthPrincipal(c);
    const userId = principal?.userId;
    if (!userId) return c.json({ error: "unauthenticated" }, 401);
    const handle = await lifecycle.use(userId); // acquire，refCount++
    c.set("engine", handle.engine);
    c.set("hub", handle.hub);
    // 每请求只 acquire 一次，必须只在一处 release 一次：
    // Hono 无 res.on('finish')；next() 完成后即请求结束，仅在此释放一次。
    try {
      await next();
    } finally {
      lifecycle.releaseRef(userId); // refCount--；归零不立即 dispose，仅启动空闲计时
    }
  };
}
