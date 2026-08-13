import { describe, expect, it } from "vitest";
import {
  isBridgeOwner,
  resolveBridgeOwnerUserId,
  resolveBridgeOwnerDeliveryTarget,
} from "../lib/bridge/owner-policy.ts";

describe("bridge owner policy", () => {
  it("treats a bound user as owner via users mapping (role defaults to user)", () => {
    const agent = {
      config: {
        bridge: {
          telegram: {
            users: { "tg-bound": { defaultAgent: "agent-2" } },
          },
        },
      },
    };

    expect(isBridgeOwner({ platform: "telegram", userId: "tg-bound", agent } as any)).toBe(true);
    expect(isBridgeOwner({ platform: "telegram", userId: "tg-stranger", agent } as any)).toBe(false);
  });

  it("honors explicit role: owner matches, guest does not", () => {
    const agent = {
      config: {
        bridge: {
          telegram: {
            users: {
              "tg-owner": { role: "owner" },
              "tg-guest": { role: "guest" },
            },
          },
        },
      },
    };

    expect(isBridgeOwner({ platform: "telegram", userId: "tg-owner", agent } as any)).toBe(true);
    expect(isBridgeOwner({ platform: "telegram", userId: "tg-guest", agent } as any)).toBe(false);
  });

  it("resolves owner userId from users mapping role=owner, falling back to scalar owner", () => {
    const withUsers = {
      config: { bridge: { telegram: { users: { "tg-a": { role: "user" }, "tg-b": { role: "owner" } } } } },
    };
    expect(resolveBridgeOwnerUserId({ platform: "telegram", agent: withUsers } as any)).toBe("tg-b");

    const withScalar = { config: { bridge: { telegram: { owner: "tg-scalar" } } } };
    expect(resolveBridgeOwnerUserId({ platform: "telegram", agent: withScalar } as any)).toBe("tg-scalar");

    const empty = { config: { bridge: { telegram: {} } } };
    expect(resolveBridgeOwnerUserId({ platform: "telegram", agent: empty } as any)).toBeNull();
  });

  it("preserves exact string owner matching for non-QQ platforms", () => {
    const agent = { config: { bridge: { telegram: { owner: "tg-owner" } } } };

    expect(isBridgeOwner({ platform: "telegram", userId: "tg-owner", agent } as any)).toBe(true);
    expect(isBridgeOwner({
      platform: "telegram",
      userId: "tg-alias",
      aliases: ["tg-owner"],
      agent,
    })).toBe(false);
  });

  it("matches QQ owners by normalized principal or alias metadata", () => {
    const agent = { config: { bridge: { qq: { owner: "c2c-openid" } } } };

    expect(isBridgeOwner({
      platform: "qq",
      userId: "principal-1",
      aliases: ["principal-1", "c2c-openid", "member-openid"],
      agent,
    })).toBe(true);
  });

  it("resolves QQ proactive delivery through principal aliases without merging unknown users", () => {
    const agent = { config: { bridge: { qq: { owner: "member-openid" } } } };
    const index = {
      "qq_dm_c2c-openid@hana": {
        file: "owner/c2c.jsonl",
        userId: "principal-1",
        chatId: "c2c-openid",
        qqPrincipal: {
          principalId: "principal-1",
          aliases: ["c2c-openid", "member-openid"],
        },
      },
      "qq_dm_other-openid@hana": {
        file: "owner/other.jsonl",
        userId: "other-principal",
        chatId: "other-openid",
        qqPrincipal: {
          principalId: "other-principal",
          aliases: ["other-openid"],
        },
      },
    };

    expect(resolveBridgeOwnerDeliveryTarget({ platform: "qq", agent, index })).toEqual({
      userId: "principal-1",
      chatId: "c2c-openid",
      sessionKey: "qq_dm_c2c-openid@hana",
    });
  });
});
