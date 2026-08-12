/**
 * server/routes/sharing.ts — M3 Sharing Market 路由（/api/sharing/*）
 *
 * 所有写操作经 userEngineMiddleware 注入 c.get('authPrincipal')/c.get('engine')。
 * 缺失 principal → 401（与 userEngineMiddleware 一致；spec 表 S1 记 403 偏差）。
 */

import { Hono } from "hono";
import * as fs from "fs";
import * as path from "path";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { readUserScript } from "../../core/user-script-runtime.ts";
import type { SharingMarket } from "../sharing/index.ts";

function principalUserId(c: any): string | null {
  const p = readAuthPrincipal(c);
  return p?.userId ?? null;
}

function userBaseDir(engine: any): string {
  // engine.hanakoHome = <baseDir>/system（即 systemRoot）
  return path.dirname(engine.hanakoHome);
}

export function createSharingRoute(
  getMarket: (c: any) => SharingMarket,
  getUserEngine: (c: any) => any,
) {
  const route = new Hono();

  const requireUser = (c: any): string | null => {
    const userId = principalUserId(c);
    if (!userId) {
      c.res = c.json({ error: "unauthenticated" }, 401);
      return null;
    }
    return userId;
  };

  // POST /api/sharing/publish  —— 发布工具/工作流
  route.post("/sharing/publish", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.res;
    const engine = getUserEngine(c);
    if (!engine) return c.json({ error: "unauthorized" }, 401);

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const kind = body?.kind;
    const sourceId = body?.sourceId;
    if (kind !== "tool" && kind !== "workflow") {
      return c.json({ error: "invalid kind" }, 400);
    }
    if (!sourceId || typeof sourceId !== "string") {
      return c.json({ error: "missing sourceId" }, 400);
    }

    let sourceContent: string | null = null;
    if (kind === "tool") {
      const def = readUserScript(userId, sourceId, engine.hanakoHome);
      sourceContent = def?.src ?? null;
    } else {
      const graphPath = path.join(userBaseDir(engine), "users", userId, "workflows", sourceId, "graph.json");
      sourceContent = fs.existsSync(graphPath) ? fs.readFileSync(graphPath, "utf8") : null;
    }
    if (sourceContent == null) {
      return c.json({ error: "source_not_found" }, 404);
    }

    try {
      const result = getMarket(c).publish({
        kind,
        sourceId,
        title: String(body?.title ?? sourceId),
        summary: String(body?.summary ?? ""),
        homepageUrl: body?.homepageUrl ? String(body.homepageUrl) : undefined,
        forkedFrom: body?.forkedFrom ? String(body.forkedFrom) : undefined,
        ownerId: userId,
        sourceContent,
      });
      return c.json(result, 201);
    } catch (e: any) {
      return c.json({ error: e?.message ?? "publish_failed" }, 500);
    }
  });

  // DELETE /api/sharing/unpublish/:id —— 下架（仅 owner）
  route.delete("/sharing/unpublish/:id", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.res;
    const id = c.req.param("id");
    const ok = getMarket(c).unpublish(id, userId);
    if (!ok) return c.json({ error: "not_owner_or_missing" }, 404);
    return c.json({ id, status: "unpublished" });
  });

  // GET /api/sharing/mine —— 我的发布列表
  route.get("/sharing/mine", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.res;
    return c.json({ assets: getMarket(c).listMine(userId) });
  });

  // GET /api/sharing/discover —— 发现/目录
  route.get("/sharing/discover", async (c) => {
    const items = await getMarket(c).discover();
    return c.json({ assets: items });
  });

  // POST /api/sharing/install —— 安装到本用户根
  route.post("/sharing/install", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.res;
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const id = body?.id;
    if (!id || typeof id !== "string") {
      return c.json({ error: "missing id" }, 400);
    }
    try {
      const result = getMarket(c).install(id, userId);
      return c.json(result, 201);
    } catch (e: any) {
      const status = e?.status ?? 500;
      return c.json({ error: e?.message ?? "install_failed" }, status);
    }
  });

  return route;
}
