/**
 * user-scripts.ts — M2-1 用户脚本工具管理路由（POST /api/tools）
 *
 * 双根模型下 getUserEngine(c) 已绑定对应 userId 的 per-user 引擎，
 * 其 hanakoHome = users/<userId>，registerUserScript 落盘到该用户根并热注册。
 */

import { Hono } from "hono";
import type { UserScriptDef } from "../../core/user-script-runtime.ts";

export function createUserScriptRoute(getEngine: (c: any) => any) {
  const route = new Hono();

  // 注册/更新用户脚本：落盘 + 热注册到 per-user 引擎
  route.post("/tools", async (c) => {
    const engine = getEngine(c);
    if (!engine) return c.json({ error: "unauthorized" }, 401);
    let def: UserScriptDef;
    try {
      def = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!def?.name || !def?.runtime || !def?.src) {
      return c.json({ error: "missing name/runtime/src" }, 400);
    }
    if (!["js", "ts", "py", "sh"].includes(def.runtime)) {
      return c.json({ error: "unsupported runtime" }, 400);
    }
    engine.registerUserScript(def);
    return c.json({ id: def.name, status: "registered" });
  });

  return route;
}
