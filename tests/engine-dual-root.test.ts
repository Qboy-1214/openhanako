import { describe, it, expect } from "vitest";
import path from "path";
import { HanaEngine } from "../core/engine.ts";

describe("HanaEngine dual root field parsing", () => {
  const productDir = process.cwd();
  const home = path.join("d:/tmp/hana", "users", "alice");
  const sys = path.join("d:/tmp/hana", "system");

  it("stores explicit systemRoot", () => {
    const e = new HanaEngine({ hanakoHome: home, systemRoot: sys, productDir });
    expect(e.hanakoHome).toBe(home);
    expect(e.systemRoot).toBe(sys);
  });

  it("falls back systemRoot = hanakoHome when omitted", () => {
    const e = new HanaEngine({ hanakoHome: home, productDir });
    expect(e.systemRoot).toBe(home);
  });
});
