import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDeskRoute } from "../server/routes/desk.ts";

describe("desk route F1 (P0-3)", () => {
  it("returns 401 when per-user engine cannot be resolved (fail-closed)", async () => {
    const app = new Hono();
    app.route("/api", createDeskRoute(() => null, {} as any)); // getEngine 始终解析失败
    const res = await app.request("/api/desk/anything");
    expect(res.status).toBe(401);
  });

  it("proceeds to handler when engine resolves (per-user engine wired)", async () => {
    const fakeEngine = { listAgents: () => [], agentName: "fake" };
    const app = new Hono();
    app.route("/api", createDeskRoute(() => fakeEngine, {} as any));
    // 解析成功 → 不再 401（具体 handler 行为不在此断言，仅验证 F1 放行）
    const res = await app.request("/api/desk/anything");
    expect(res.status).not.toBe(401);
  });
});
