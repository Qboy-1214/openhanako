import { test, expect } from "@playwright/test";

/**
 * 验证 dev:web 的 Vite 代理把前端 /api/* 请求正确转发到 Hana server。
 *
 * 注意：在全新 dev:web 环境（还未创建任何 agent）下，/api/health 的
 * engine.agentName getter 会因无 agent 而抛错，导致后端返回 500（UNKNOWN）。
 * 这是后端已知的健壮性缺陷（health 端点在 agent 缺失时本应优雅返回 null，
 * 而非 500），详见下方基线断言。本测试聚焦验证「代理连通」这一 E2E 关注点：
 * 请求确实被转发到后端并拿到结构化响应。
 */
test.describe("dev:web API proxy (health)", () => {
  test("GET /api/health is proxied to the backend and returns a structured JSON response", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    // 200（有 agent）或 500（无 agent 的 dev 环境）都证明请求到达了后端，
    // 而非代理连接失败。连接失败会表现为 502/ECONNREFUSED，而非受控的 JSON 错误体。
    expect([200, 500]).toContain(res.status());

    const body = (await res.json()) as {
      status?: string;
      version?: string;
      error?: { code?: string; message?: string };
    };
    // 后端结构化响应：要么正常 health，要么受控错误体。
    const isHealthOk = body.status === "ok" && typeof body.version === "string";
    const isControlledError =
      typeof body.error?.code === "string" && typeof body.error?.message === "string";
    expect(isHealthOk || isControlledError, JSON.stringify(body)).toBe(true);
  });

  test("no-agent dev environment: health currently returns 500 UNKNOWN (baseline, see note)", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    if (res.status() === 200) {
      // 若环境已初始化 agent，跳过基线断言。
      test.skip(true, "agent already initialized, no-agent baseline not applicable");
      return;
    }
    expect(res.status()).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("UNKNOWN");
    expect(body.error?.message ?? "").toContain("助手");
  });
});
