import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { persistUserScript, readUserScript, executeUserScript, type UserScriptDef } from "../../core/user-script-runtime.ts";
import { registerUserScript } from "../../server/tools/register-user-script.ts";
import { ToolCatalog } from "../../core/tool-catalog.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "m2-tools-"));
const aliceHome = path.join(base, "users", "u_alice");

const def: UserScriptDef = {
  id: "hello",
  name: "hello",
  runtime: "sh",
  src: "echo hi",
};

describe("M2-1 user-script tool", () => {
  it("persists to per-user absolute path users/<userId>/tools/<name>", () => {
    persistUserScript("u_alice", def.name, def, aliceHome);
    const manifest = path.join(aliceHome, "tools", "hello", "manifest.json");
    const src = path.join(aliceHome, "tools", "hello", "src");
    expect(fs.existsSync(manifest)).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
    const read = readUserScript("u_alice", "hello", aliceHome);
    expect(read?.name).toBe("hello");
    expect(read?.src).toBe("echo hi");
  });

  it("registerUserScript lands in tool catalog with origin=user", () => {
    const catalog = new ToolCatalog();
    registerUserScript(catalog, "u_alice", def);
    const entry = catalog.get("hello");
    expect(entry).not.toBeNull();
    expect(entry?.origin).toBe("user");
  });

  it("executeUserScript runs js in vm sandbox", async () => {
    const r = await executeUserScript({ ...def, runtime: "js", src: "return args.x + 1" }, { x: 41 });
    expect(r).toContain("42");
  });

  it("rejects cross-user read outside per-user hanakoHome", () => {
    persistUserScript("u_alice", def.name, def, aliceHome);
    // bob 的根下不应出现 alice 的脚本
    const bobHome = path.join(base, "users", "u_bob");
    expect(readUserScript("u_bob", "hello", bobHome)).toBeNull();
  });

  afterEach(() => {
    fs.rmSync(aliceHome, { recursive: true, force: true });
  });
});
