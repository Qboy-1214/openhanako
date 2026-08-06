import { describe, it, expect } from "vitest";
import path from "path";
import { makeBusinessStore, makeSystemStore, SYSTEM_STORE_KINDS } from "../core/multiuser/user-db.ts";
import { assertWithinUserRoot, PathGuardError } from "../core/multiuser/paths.ts";

describe("user-db dual root", () => {
  const base = "/tmp/hana";

  it("business store baseDir is userHome, system store baseDir is system", () => {
    const biz = makeBusinessStore(base, "alice", "agent-facts");
    const sys = makeSystemStore(base, "users");
    // makeBusinessStore 只算用户业务根（不含 kind），kind 由调用方用于具体 store
    expect(biz.baseDir).toBe(path.join(base, "users", "alice"));
    expect(biz.kind).toBe("agent-facts");
    expect(sys.baseDir).toBe(path.join(base, "system"));
  });

  it("makeSystemStore rejects non-system kind", () => {
    expect(() => makeSystemStore(base, "agent-facts")).toThrow();
  });

  it("SYSTEM_STORE_KINDS includes auth/sessions/grants", () => {
    for (const k of ["users", "auth", "web-sessions", "grants"]) {
      expect(SYSTEM_STORE_KINDS.has(k)).toBe(true);
    }
  });

  it("assertWithinUserRoot rejects caller-selected absolute path", () => {
    expect(() => assertWithinUserRoot("alice", "/tmp/evil.txt")).toThrow(PathGuardError);
  });
});
