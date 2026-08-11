import { describe, it, expect } from "vitest";
import { resolveOwnerUserId, registerSessionOwner } from "../core/session-manifest/owner";

describe("session -> ownerUserId mapping", () => {
  it("resolves owner from per-user sessionPath", () => {
    expect(resolveOwnerUserId("users/u_alice/sessions/s1")).toBe("u_alice");
  });
  it("returns null for system events without sessionPath", () => {
    expect(resolveOwnerUserId(null)).toBeNull();
    expect(resolveOwnerUserId(undefined)).toBeNull();
  });
  it("resolves owner for bridge/agent sessions via manifest index", () => {
    // bridge/b1 无 users/ 前缀，前缀解析返回 null；须先经 Step 0 运行时补写索引
    registerSessionOwner("bridge/b1", "u_alice");
    expect(resolveOwnerUserId("bridge/b1")).toBe("u_alice");
  });
});
