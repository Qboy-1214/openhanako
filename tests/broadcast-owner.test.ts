import { describe, it, expect } from "vitest";
import { matchesBroadcastOwner } from "../server/ws/broadcast-owner.ts";
import { resolveOwnerUserId, registerSessionOwner } from "../core/session-manifest/owner.ts";

describe("P0-2 broadcast owner filtering", () => {
  const alice = { principal: { userId: "u_alice" } };
  const bob = { principal: { userId: "u_bob" } };

  it("global event (ownerUserId undefined) reaches all clients", () => {
    expect(matchesBroadcastOwner(alice, undefined)).toBe(true);
    expect(matchesBroadcastOwner(bob, undefined)).toBe(true);
  });

  it("owner-scoped event only reaches the owner client", () => {
    expect(matchesBroadcastOwner(alice, "u_alice")).toBe(true);
    expect(matchesBroadcastOwner(bob, "u_alice")).toBe(false); // 跨用户隔离
  });

  it("resolves owner from per-user sessionPath", () => {
    expect(resolveOwnerUserId("users/u_alice/sessions/s1")).toBe("u_alice");
  });

  it("returns null for unresolved owner (caller must fail-closed drop)", () => {
    expect(resolveOwnerUserId("bridge/unregistered-b1")).toBeNull();
  });

  it("indexed bridge session resolves after registerSessionOwner", () => {
    registerSessionOwner("bridge/b1", "u_alice");
    expect(resolveOwnerUserId("bridge/b1")).toBe("u_alice");
  });
});
