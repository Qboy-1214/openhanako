import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { EngineLifecycle } from "../../core/engine-lifecycle.ts";
import { userEngineMiddleware } from "../../server/composition/user-engine-middleware.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-e2e-"));
}

const lcList: EngineLifecycle[] = [];

afterEach(async () => {
  while (lcList.length) {
    await lcList.pop()!.drainAll();
  }
});

/**
 * Task 9 E2E 验收（🟠较高）：多用户隔离端到端验证。
 * 起一个最小 Hono app，挂载 userEngineMiddleware + 一个返回当前用户 hanakoHome 的 /me 路由，
 * 用两个不同 userId 的请求断言各自解析到独立业务根（且 systemRoot 共享）。
 */
describe("multiuser server E2E (Task 9)", () => {
  it("different authenticated users get isolated hanakoHome, shared systemRoot", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    lcList.push(lc);

    const app = new Hono();
    // 测试用 auth：从 x-user-id header 注入 principal
    app.use("*", async (c, next) => {
      const userId = c.req.header("x-user-id");
      if (userId) c.set("authPrincipal", { userId, principalId: userId, scopes: ["USER"] });
      await next();
    });
    app.use("*", userEngineMiddleware(lc));
    app.get("/me", (c) => {
      const engine = c.get("engine");
      return c.json({ hanakoHome: engine.hanakoHome, systemRoot: engine.systemRoot });
    });

    const resA = await app.request("/me", { headers: { "x-user-id": "u_a" } });
    const resB = await app.request("/me", { headers: { "x-user-id": "u_b" } });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const a = await resA.json();
    const b = await resB.json();

    expect(a.hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
    expect(b.hanakoHome).toBe(path.join(baseDir, "users", "u_b"));
    expect(a.hanakoHome).not.toBe(b.hanakoHome);
    expect(a.systemRoot).toBe(b.systemRoot);
  });

  it("unauthenticated request is rejected (401)", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    lcList.push(lc);

    const app = new Hono();
    app.use("*", userEngineMiddleware(lc));
    app.get("/me", (c) => c.json({ ok: true }));

    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });
});
