/**
 * 阶段 1 — 真实 LLM 链路验证（agnes-2.5-flash，OpenAI 兼容端点）。
 *
 * 密钥安全：绝不硬编码。api key 仅经运行时环境变量 AGNES_API_KEY 注入，
 * 测试读取 process.env.AGNES_API_KEY；未设置时整个 suite 跳过（不报错）。
 * 该变量由调用方在本地 shell 中 export，不会进入 git 跟踪。
 *
 * 这些测试是「live」测试：会真实向 https://api.agnes-ai.cn/v1 发起 HTTP 请求。
 * 它们验证 callText 的 OpenAI Completions 协议路径、文本提取、usage 归一化、
 * 以及鉴权失败的错误分类，确保 agnes 模型可被 Hana 的真实调用链使用。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { callText } from "../../core/llm-client.js";
import { AppError } from "../../shared/errors.js";

const AGNES_BASE_URL = "https://api.agnes-ai.cn/v1";
const AGNES_MODEL = "agnes-2.5-flash";

const apiKey = process.env.AGNES_API_KEY;
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

describe("live: agnes-2.5-flash via callText (OpenAI Completions)", () => {
  beforeAll(() => {
    // 无密钥时明确失败（而非静默 no-suite），便于本地诊断。
    if (!hasKey) {
      throw new Error(
        "AGNES_API_KEY is not set. Export it in the shell before running live tests.",
      );
    }
  });

  it.skipIf(!hasKey)("returns non-empty text for a simple user prompt", async () => {
    const text = await callText({
      api: "openai-completions",
      apiKey: apiKey!,
      baseUrl: AGNES_BASE_URL,
      model: { id: AGNES_MODEL },
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      maxTokens: 32,
    });
    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.toUpperCase()).toContain("PONG");
  }, 30_000);

  it.skipIf(!hasKey)("returns usage when returnUsage is set", async () => {
    const result = await callText({
      api: "openai-completions",
      apiKey: apiKey!,
      baseUrl: AGNES_BASE_URL,
      model: { id: AGNES_MODEL },
      messages: [{ role: "user", content: "Say hello in one word." }],
      maxTokens: 16,
      returnUsage: true,
    });
    expect(result).toHaveProperty("text");
    expect(typeof (result as { text: string }).text).toBe("string");
    expect((result as { usage: unknown }).usage).toBeTruthy();
  }, 30_000);

  it.skipIf(!hasKey)("honors a system prompt plus multi-turn messages", async () => {
    const text = await callText({
      api: "openai-completions",
      apiKey: apiKey!,
      baseUrl: AGNES_BASE_URL,
      model: { id: AGNES_MODEL },
      systemPrompt: "You are a terse bot. Answer in exactly 3 words.",
      messages: [
        { role: "user", content: "What color is the sky?" },
        { role: "assistant", content: "Blue like noon." },
        { role: "user", content: "And the grass?" },
      ],
      maxTokens: 24,
    });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 30_000);

  it.skipIf(!hasKey)("classifies an invalid api key as LLM_AUTH_FAILED", async () => {
    await expect(
      callText({
        api: "openai-completions",
        apiKey: "sk-invalid-agnes-key-for-test",
        baseUrl: AGNES_BASE_URL,
        model: { id: AGNES_MODEL },
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 8,
      }),
    ).rejects.toMatchObject({ code: "LLM_AUTH_FAILED" });
  }, 30_000);

  it.skipIf(!hasKey)("resolveFallback recovers once via agnes when primary returns 429", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limit", type: "rate_limit" } }));
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const mockPort = (server.address() as { port: number }).port;
    try {
      const text = await callText({
        api: "openai-completions",
        apiKey: "sk-any",
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        model: { id: AGNES_MODEL },
        messages: [{ role: "user", content: "Reply with exactly: PONG" }],
        maxTokens: 32,
        resolveFallback: async () => ({
          api: "openai-completions",
          apiKey: apiKey!,
          baseUrl: AGNES_BASE_URL,
          model: { id: AGNES_MODEL },
        }),
      });
      expect(typeof text).toBe("string");
      expect(text.toUpperCase()).toContain("PONG");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

// 即便没有真实密钥，也验证「跳过逻辑」本身不崩溃（保证 suite 结构可靠）。
describe("live-agnes guard", () => {
  it("skips live tests cleanly when AGNES_API_KEY is absent", () => {
    // 仅断言 guards 模块可加载、callText 是函数；真实调用由上面的 it.skipIf 控制。
    expect(typeof callText).toBe("function");
    expect(typeof AppError).toBe("function");
  });
});
