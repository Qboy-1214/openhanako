import { describe, it, expect } from "vitest";
import path from "path";
import {
  userHomePath,
  systemHomePath,
  resolveUserHome,
  resolveSystemHome,
  assertWithinUserRoot,
  PathGuardError,
} from "../core/multiuser/paths.ts";

describe("multiuser paths", () => {
  it("userHomePath returns users/<userId>", () => {
    expect(userHomePath("alice")).toBe(path.join("users", "alice"));
  });

  it("systemHomePath returns system", () => {
    expect(systemHomePath()).toBe("system");
  });

  it("resolveUserHome / resolveSystemHome combine baseDir", () => {
    const base = "/tmp/hana";
    expect(resolveUserHome(base, "alice")).toBe(path.join(base, "users", "alice"));
    expect(resolveSystemHome(base)).toBe(path.join(base, "system"));
  });

  it("assertWithinUserRoot accepts path under the user root", () => {
    const base = "/tmp/hana";
    expect(() =>
      assertWithinUserRoot("alice", path.join(base, "users", "alice", "x.txt"), base)
    ).not.toThrow();
  });

  it("assertWithinUserRoot rejects path outside the user root", () => {
    const base = "/tmp/hana";
    expect(() =>
      assertWithinUserRoot("alice", path.join(base, "users", "bob", "x.txt"), base)
    ).toThrow(PathGuardError);
    expect(() =>
      assertWithinUserRoot("alice", "/etc/passwd", base)
    ).toThrow(PathGuardError);
  });
});
