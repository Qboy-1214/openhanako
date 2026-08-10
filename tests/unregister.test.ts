import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  softDeleteUser,
  hardDeleteUser,
  countSystemAdmins,
  LastAdminError,
} from "../server/auth/unregister.ts";
import { systemStoreDir } from "../shared/persistence/store-registry.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-unregister-"));
}

const bases: string[] = [];

afterEach(() => {
  while (bases.length) {
    const b = bases.pop()!;
    fs.rmSync(b, { recursive: true, force: true });
  }
});

function writeUsers(baseDir: string, users: any[]) {
  const dir = systemStoreDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify({ users, defaultUserId: null }, null, 2));
}

describe("unregister (Task 5/6)", () => {
  it("countSystemAdmins counts SYSTEM_ADMIN scoped users", () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    writeUsers(baseDir, [
      { userId: "u_a", scopes: ["USER", "SYSTEM_ADMIN"] },
      { userId: "u_b", scopes: ["USER"] },
    ]);
    expect(countSystemAdmins(baseDir)).toBe(1);
  });

  it("softDeleteUser marks user disabled", async () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    writeUsers(baseDir, [{ userId: "u_a", scopes: ["USER"] }]);
    await softDeleteUser(baseDir, "u_a");
    const dir = systemStoreDir(baseDir);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
    expect(doc.users[0].disabled).toBe(true);
  });

  it("hardDeleteUser removes the user record", async () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    fs.mkdirSync(path.join(baseDir, "users", "u_a"), { recursive: true });
    writeUsers(baseDir, [{ userId: "u_a", scopes: ["USER"] }]);
    await hardDeleteUser(baseDir, "u_a");
    const dir = systemStoreDir(baseDir);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
    expect(doc.users.find((u: any) => u.userId === "u_a")).toBeUndefined();
    expect(fs.existsSync(path.join(baseDir, "users", "u_a"))).toBe(false);
  });

  it("hardDeleteUser refuses to delete the last system admin (LastAdminError)", async () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    writeUsers(baseDir, [{ userId: "u_a", scopes: ["USER", "SYSTEM_ADMIN"] }]);
    await expect(hardDeleteUser(baseDir, "u_a")).rejects.toBeInstanceOf(LastAdminError);
  });
});
