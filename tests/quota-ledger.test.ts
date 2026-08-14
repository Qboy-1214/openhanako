import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { QuotaLedger, logicalDateKey } from "../lib/llm/quota-ledger.ts";

describe("lib/llm/quota-ledger", () => {
  let dir: string;
  const ORIGINAL_TZ = process.env.HANA_QUOTA_TZ;
  const ORIGINAL_QUOTA = process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-"));
    delete process.env.HANA_QUOTA_TZ;
    delete process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_TZ === undefined) delete process.env.HANA_QUOTA_TZ;
    else process.env.HANA_QUOTA_TZ = ORIGINAL_TZ;
    if (ORIGINAL_QUOTA === undefined) delete process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS;
    else process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS = ORIGINAL_QUOTA;
  });

  it("isFallbackModel is false when no fallback configured", () => {
    const q = new QuotaLedger(dir);
    expect(q.isFallbackModel("openai/gpt-4o")).toBe(false);
    expect(q.isFallbackModel({ id: "gpt-4o", provider: "openai" })).toBe(false);
  });

  it("isFallbackModel matches by id+provider after setFallbackModel", () => {
    const q = new QuotaLedger(dir);
    q.setFallbackModel({ id: "gpt-4o", provider: "openai" });
    expect(q.isFallbackModel("openai/gpt-4o")).toBe(true);
    expect(q.isFallbackModel({ id: "gpt-4o", provider: "openai" })).toBe(true);
    expect(q.isFallbackModel("anthropic/claude")).toBe(false);
  });

  it("checkLlmQuota allows non-fallback models regardless of quota", () => {
    process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS = "10";
    const q = new QuotaLedger(dir);
    q.setFallbackModel({ id: "gpt-4o", provider: "openai" });
    // 用户自添模型不受限
    expect(q.checkLlmQuota("user1", "anthropic/claude").ok).toBe(true);
  });

  it("checkLlmQuota blocks fallback when over daily quota", () => {
    process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS = "10";
    const q = new QuotaLedger(dir);
    q.setFallbackModel({ id: "gpt-4o", provider: "openai" });
    q.recordFallbackUsage("user1", 10);
    expect(q.isOverQuota("user1")).toBe(true);
    expect(q.checkLlmQuota("user1", "openai/gpt-4o").ok).toBe(false);
    expect(q.checkLlmQuota("user1", "openai/gpt-4o").reason).toBe("quota_exceeded");
  });

  it("checkLlmQuota allows fallback under quota", () => {
    process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS = "100";
    const q = new QuotaLedger(dir);
    q.setFallbackModel({ id: "gpt-4o", provider: "openai" });
    q.recordFallbackUsage("user1", 10);
    expect(q.checkLlmQuota("user1", "openai/gpt-4o").ok).toBe(true);
  });

  it("quota accumulates per userId independently", () => {
    process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS = "10";
    const q = new QuotaLedger(dir);
    q.setFallbackModel({ id: "gpt-4o", provider: "openai" });
    q.recordFallbackUsage("user1", 10);
    expect(q.isOverQuota("user1")).toBe(true);
    expect(q.isOverQuota("user2")).toBe(false);
  });

  it("logicalDateKey rolls over at 04:00 (UTC)", () => {
    process.env.HANA_QUOTA_TZ = "UTC";
    const before = new Date(Date.UTC(2026, 7, 14, 3, 0, 0)); // 08-14 03:00 UTC
    const after = new Date(Date.UTC(2026, 7, 14, 5, 0, 0)); // 08-14 05:00 UTC
    expect(logicalDateKey(before, "UTC")).toBe("2026-08-13");
    expect(logicalDateKey(after, "UTC")).toBe("2026-08-14");
  });

  it("getUsage resets across logical day boundary", () => {
    process.env.HANA_QUOTA_TZ = "UTC";
    const q = new QuotaLedger(dir);
    // 直接写入两个逻辑日的 bucket 以验证惰性重置语义
    (q as any).load();
    (q as any)._data.buckets["2026-08-13"] = { user1: 999 };
    (q as any)._data.buckets["2026-08-14"] = { user1: 5 };
    // 以 08-14 05:00 为"现在"，应只看到 08-14 的 5
    const now = new Date(Date.UTC(2026, 7, 14, 5, 0, 0));
    expect(q.getUsage("user1", logicalDateKey(now, "UTC"))).toBe(5);
  });

  it("HANA_QUOTA_TZ changes the logical day boundary (America/Los_Angeles)", () => {
    process.env.HANA_QUOTA_TZ = "America/Los_Angeles";
    // 2026-08-14T03:00 LA 在 LA 本地时间为 03:00 (< 04:00)，逻辑日属于前一天 2026-08-13
    const la3am = new Date("2026-08-14T03:00:00-07:00");
    expect(logicalDateKey(la3am, "America/Los_Angeles")).toBe("2026-08-13");
    // 同一时间点在 UTC 是 10:00 (>= 04:00)，在 UTC 逻辑日属于 2026-08-14
    expect(logicalDateKey(la3am, "UTC")).toBe("2026-08-14");
    // 2026-08-14T05:00 LA 在 LA 本地时间为 05:00 (>= 04:00)，逻辑日属于当天 2026-08-14
    const la5am = new Date("2026-08-14T05:00:00-07:00");
    expect(logicalDateKey(la5am, "America/Los_Angeles")).toBe("2026-08-14");
  });

  it("self-heals on corrupt ledger file (no throw)", () => {
    fs.writeFileSync(path.join(dir, "quota-ledger.json"), "{not json");
    const q = new QuotaLedger(dir);
    expect(() => q.getUsage("x")).not.toThrow();
    expect(q.getUsage("x")).toBe(0);
  });
});
