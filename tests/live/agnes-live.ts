/**
 * 方案 2 — 用 Node 原生 test runner + esbuild 打包执行，验证 agnes-2.5-flash
 * 能经项目真实的 callText 链路（OpenAI Completions 协议）完成调用。
 *
 * 绕过 vitest 4 在本项目单/少文件运行时的 "find the current suite" runner 上下文
 * bug。本文件由 tests/live/run-agnes.mjs 经 esbuild 打包为单一 .mjs 后用
 * `node --test` 执行。
 *
 * 密钥：仅从 process.env.AGNES_API_KEY 读取，绝不硬编码，不进 git。
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callText } from "../../core/llm-client.ts";

const AGNES_BASE_URL = "https://api.agnes-ai.cn/v1";
const AGNES_MODEL = "agnes-2.5-flash";

const apiKey = process.env.AGNES_API_KEY;
const hasKey = typeof apiKey === "string" && apiKey.length > 0;

describe("live: agnes-2.5-flash via project callText", () => {
  before(() => {
    if (!hasKey) {
      throw new Error("AGNES_API_KEY not set — export it before running (scheme 2).");
    }
  });

  test("returns non-empty text for a simple prompt", async () => {
    const text = await callText({
      api: "openai-completions",
      apiKey: apiKey!,
      baseUrl: AGNES_BASE_URL,
      model: { id: AGNES_MODEL },
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      maxTokens: 32,
    });
    assert.equal(typeof text, "string");
    assert.ok(text.trim().length > 0, "response should not be empty");
    assert.ok(text.toUpperCase().includes("PONG"), `expected PONG in: ${text}`);
  });

  test("returns usage when returnUsage is set", async () => {
    const result = (await callText({
      api: "openai-completions",
      apiKey: apiKey!,
      baseUrl: AGNES_BASE_URL,
      model: { id: AGNES_MODEL },
      messages: [{ role: "user", content: "Say hello in one word." }],
      maxTokens: 16,
      returnUsage: true,
    })) as { text: string; usage: unknown };
    assert.equal(typeof result.text, "string");
    assert.ok(result.usage, "usage should be present when returnUsage=true");
  });

  test("honors system prompt + multi-turn messages", async () => {
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
    assert.ok(text.trim().length > 0);
  });

  test("classifies an invalid api key as auth failure", async () => {
    await assert.rejects(
      callText({
        api: "openai-completions",
        apiKey: "sk-invalid-agnes-key-for-test",
        baseUrl: AGNES_BASE_URL,
        model: { id: AGNES_MODEL },
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 8,
      }),
      (err: unknown) => {
        const e = err as { code?: string; name?: string };
        return e.name === "AppError" && e.code === "LLM_AUTH_FAILED";
      },
    );
  });

  test("resolveFallback recovers once via agnes when primary returns 429 (real fallback recursion)", async () => {
    // 主调用指向本地 mock server，返回 429 → callText 分类为 LLM_RATE_LIMITED
    // （shouldFailover 三码之一）→ resolveFallback 返回真实 agnes 配置 →
    // callText 递归一次成功。验证 M5 D3 failover 机制真实可用。
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
      assert.equal(typeof text, "string");
      assert.ok(text.toUpperCase().includes("PONG"), `expected PONG in: ${text}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
