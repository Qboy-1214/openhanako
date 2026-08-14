import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RETRYABLE_FALLBACK_CODES,
  resolveFallbackModelRef,
  shouldFailover,
} from "../lib/llm/failover.ts";

describe("lib/llm/failover", () => {
  const ORIG = process.env.HANA_FALLBACK_MODEL;

  beforeEach(() => { delete process.env.HANA_FALLBACK_MODEL; });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.HANA_FALLBACK_MODEL;
    else process.env.HANA_FALLBACK_MODEL = ORIG;
  });

  it("shouldFailover true only for strict three LLM retryable codes", () => {
    expect(shouldFailover({ code: "LLM_TIMEOUT" })).toBe(true);
    expect(shouldFailover({ code: "LLM_RATE_LIMITED" })).toBe(true);
    expect(shouldFailover({ code: "LLM_EMPTY_RESPONSE" })).toBe(true);
  });

  it("shouldFailover false for non-retryable / non-LLM codes", () => {
    expect(shouldFailover({ code: "LLM_AUTH_FAILED" })).toBe(false);
    expect(shouldFailover({ code: "LLM_SLOW_RESPONSE" })).toBe(false);
    expect(shouldFailover({ code: "SOME_OTHER" })).toBe(false);
    expect(shouldFailover(null)).toBe(false);
    expect(shouldFailover({})).toBe(false);
  });

  it("RETRYABLE_FALLBACK_CODES matches exactly three codes", () => {
    expect([...RETRYABLE_FALLBACK_CODES].sort()).toEqual(
      ["LLM_EMPTY_RESPONSE", "LLM_RATE_LIMITED", "LLM_TIMEOUT"].sort(),
    );
  });

  it("resolveFallbackModelRef parses provider/id form", () => {
    process.env.HANA_FALLBACK_MODEL = "openai/gpt-4o";
    expect(resolveFallbackModelRef()).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("resolveFallbackModelRef returns null when unset", () => {
    expect(resolveFallbackModelRef()).toBeNull();
  });

  it("resolveFallbackModelRef treats bare id as custom provider", () => {
    process.env.HANA_FALLBACK_MODEL = "my-model";
    expect(resolveFallbackModelRef()).toEqual({ provider: "custom", id: "my-model" });
  });
});
