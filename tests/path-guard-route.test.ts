import { describe, it, expect } from "vitest";
import * as path from "path";
import { deriveSandboxPolicy } from "../lib/sandbox/policy";
import { PathGuard } from "../lib/sandbox/path-guard";

const baseDir = "/data/hanako";
const userHome = (u: string) => path.join(baseDir, "users", u);

describe("per-user hanakoHome isolation", () => {
  it("alice cannot read bob's home", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "users", "bob", "secret.txt"))).toBe("blocked");
  });
  it("alice can read her own home", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "users", "alice", "file.txt"))).not.toBe("blocked");
  });
  it("alice cannot read SystemDB (defense-in-depth)", () => {
    const policy = deriveSandboxPolicy({ agentDir: "", cwd: userHome("alice"), workspace: userHome("alice"), workspaceFolders: [], hanakoHome: userHome("alice"), mode: "standard" });
    const guard = new PathGuard(policy);
    expect(guard.getAccessLevel(path.join(baseDir, "systemdb.sqlite"))).toBe("blocked");
    expect(guard.getAccessLevel(path.join(baseDir, "users", "_system"))).toBe("blocked");
  });
});
