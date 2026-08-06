import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { registerUser, readUsersJson, findUserByUsername, getScopes } from "../server/auth/register.ts";
import { verifyLocalAccountPassword } from "../core/local-user-account.ts";

describe("register", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "hana-reg-"));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("first registrant becomes SYSTEM_ADMIN + default", async () => {
    const u = await registerUser(base, { username: "alice", password: "password1", displayName: "Alice" });
    const users = readUsersJson(base);
    expect(users.defaultUserId).toBe(u.userId);
    expect(u.scopes).toContain("SYSTEM_ADMIN");
    expect(getScopes(base, u.userId)).toContain("SYSTEM_ADMIN");
  });

  it("concurrent first registration yields exactly one SYSTEM_ADMIN", async () => {
    const results = await Promise.all([
      registerUser(base, { username: "a", password: "password1", displayName: "A" }),
      registerUser(base, { username: "b", password: "password2", displayName: "B" }),
    ]);
    const admins = results.filter((r) => r.scopes.includes("SYSTEM_ADMIN"));
    expect(admins.length).toBe(1); // 注册锁生效
  });

  it("second user gets isolated home dir created", async () => {
    await registerUser(base, { username: "alice", password: "password1", displayName: "A" });
    const b = await registerUser(base, { username: "bob", password: "password2", displayName: "B" });
    expect(fs.existsSync(path.join(base, "users", b.userId))).toBe(true);
  });

  it("username conflict rejected", async () => {
    await registerUser(base, { username: "alice", password: "password1", displayName: "A" });
    await expect(
      registerUser(base, { username: "alice", password: "password9", displayName: "A2" })
    ).rejects.toThrow("username_taken");
  });

  it("password lands in system/local-user-auth.json and verifies", async () => {
    await registerUser(base, { username: "alice", password: "password1", displayName: "A" });
    expect(fs.existsSync(path.join(base, "system", "local-user-auth.json"))).toBe(true);
    const sysHome = path.join(base, "system");
    const ok = verifyLocalAccountPassword(sysHome, { username: "alice", password: "password1" });
    expect(ok.ok).toBe(true);
    const bad = verifyLocalAccountPassword(sysHome, { username: "alice", password: "wrongpw" });
    expect(bad.ok).toBe(false);
  });

  it("findUserByUsername / getScopes read-only helpers", async () => {
    const u = await registerUser(base, { username: "alice", password: "password1", displayName: "A" });
    expect(findUserByUsername(base, "alice")?.userId).toBe(u.userId);
    expect(findUserByUsername(base, "nope")).toBeNull();
    expect(getScopes(base, u.userId)).toContain("SYSTEM_ADMIN");
  });
});
