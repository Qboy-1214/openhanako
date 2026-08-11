import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { persistUserScript, readUserScript, registerUserScript, executeUserScript, type UserScriptDef } from "../core/user-script-runtime.ts";
import { ToolCatalog } from "../core/tool-catalog.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "m2-userscript-"));
const aliceHome = path.join(base, "users", "u_alice");
const bobHome = path.join(base, "users", "u_bob");

const def: UserScriptDef = {
  id: "s1",
  name: "greet",
  runtime: "js",
  src: "return 'hello ' + (args.name || 'world')",
  schema: { type: "object", properties: { name: { type: "string" } } },
};

describe("M2-1 user scripts", () => {
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("persists to per-user absolute path users/<userId>/tools/<name>", () => {
    persistUserScript("u_alice", def.name, def, aliceHome);
    const manifest = path.join(aliceHome, "tools", "greet", "manifest.json");
    const src = path.join(aliceHome, "tools", "greet", "src");
    expect(fs.existsSync(manifest)).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
    // 不应出现在 bob 的根下（隔离）
    expect(fs.existsSync(path.join(bobHome, "tools", "greet"))).toBe(false);
  });

  it("readUserScript round-trips", () => {
    persistUserScript("u_alice", def.name, def, aliceHome);
    const back = readUserScript("u_alice", "greet", aliceHome);
    expect(back?.name).toBe("greet");
    expect(back?.src).toBe(def.src);
  });

  it("registerUserScript lands in tool catalog with origin=user", () => {
    const catalog = new ToolCatalog();
    registerUserScript(catalog, "u_alice", def);
    const entry = catalog.all().find((e) => e.name === "greet");
    expect(entry?.origin).toBe("user");
    expect(entry?.serverId).toBe("user:u_alice");
  });

  it("executeUserScript runs js in sandbox", async () => {
    const out = await executeUserScript(def, { name: "alice" }, {});
    expect(String(out)).toContain("hello alice");
  });

  it("cross-user isolation: bob cannot read alice's script", () => {
    persistUserScript("u_alice", def.name, def, aliceHome);
    expect(readUserScript("u_bob", "greet", bobHome)).toBeNull();
  });
});
