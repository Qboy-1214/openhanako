import { describe, expect, it } from "vitest";
import { createRequestContext } from "../server/http/boundary.ts";

// 构造最小 Hono context 替身：仅暴露 get() 以还原 authPrincipal。
function fakeContext(authPrincipal: unknown) {
  const store = new Map<string, unknown>([["authPrincipal", authPrincipal]]);
  return { get: (k: string) => store.get(k) } as any;
}

// 最小 engine 替身：提供 getRuntimeContext()。
function fakeEngine(runtimeContext: unknown) {
  return { getRuntimeContext: () => runtimeContext } as any;
}

describe("createRequestContext studio alignment (local server)", () => {
  it("aligns a stale web-session studioId to the current runtime studioId on a local server", () => {
    // 复现 dev:web 重启后旧浏览器 cookie（旧 studioId）访问 /api/sessions
    // 触发 403 studio_scope_mismatch 的根因：本地单 studio server 只有这一个
    // studio，旧身份应绑定到当前 runtime studio 而非被当作 scope 不匹配拒绝。
    const runtimeStudioId = "studio_9798c310-0000-0000-0000-000000000000";
    const staleStudioId = "studio_OLDSTALE-0000-1111-2222-3333";

    const principal = {
      kind: "account_user",
      principalId: "principal_test",
      userId: "user_2be7afdd-258c-4384-9418-16e0f6357699",
      studioId: staleStudioId,
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      connectionKind: "local",
      credentialKind: "user_session",
      trustState: "local",
      scopes: ["chat", "studio.owner"],
    };

    const engine = fakeEngine({
      studioId: runtimeStudioId,
      connectionKind: "local",
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
    });

    const ctx = createRequestContext(fakeContext(principal), engine);

    // 对齐生效：authPrincipal.studioId 被改写为 runtime studioId。
    expect(ctx.authPrincipal.studioId).toBe(runtimeStudioId);
    expect(ctx.studioId).toBe(runtimeStudioId);
    expect(ctx.studioId).not.toBe(staleStudioId);
  });

  it("does not mangle a principal whose studioId already matches the runtime", () => {
    const runtimeStudioId = "studio_9798c310-0000-0000-0000-000000000000";
    const principal = {
      kind: "local_user",
      principalId: "principal_loop",
      userId: "user_2be7afdd-258c-4384-9418-16e0f6357699",
      studioId: runtimeStudioId,
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      connectionKind: "local",
      credentialKind: "loopback_token",
      trustState: "local",
      scopes: ["chat"],
    };
    const engine = fakeEngine({
      studioId: runtimeStudioId,
      connectionKind: "local",
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
    });
    const ctx = createRequestContext(fakeContext(principal), engine);
    expect(ctx.authPrincipal.studioId).toBe(runtimeStudioId);
  });

  it("does NOT align on a remote/non-local server, preserving platform studio semantics", () => {
    // 远程/多 studio server 必须保留 principal 自带的 studioId（来自平台侧），
    // 不能强行覆盖为本地 runtime studioId，否则会破坏跨 studio 隔离语义。
    const runtimeStudioId = "studio_runtime-0000-0000-0000-000000000000";
    const principalStudioId = "studio_remote-1111-1111-1111-111111111111";
    const principal = {
      kind: "device",
      principalId: "principal_dev",
      userId: "user_remote",
      studioId: principalStudioId,
      serverId: "server_remote",
      serverNodeId: "server_remote",
      connectionKind: "lan",
      credentialKind: "device_credential",
      trustState: "lan",
      scopes: ["chat"],
    };
    const engine = fakeEngine({
      studioId: runtimeStudioId,
      connectionKind: "lan",
      serverId: "server_remote",
      serverNodeId: "server_remote",
    });
    const ctx = createRequestContext(fakeContext(principal), engine);
    // 不对齐：保留原 platform studioId。
    expect(ctx.authPrincipal.studioId).toBe(principalStudioId);
  });

  it("leaves a studio-less local principal as-is (runtime fallback handles scope, no mismatch)", () => {
    const runtimeStudioId = "studio_9798c310-0000-0000-0000-000000000000";
    const principal = {
      kind: "local_user",
      principalId: "principal_nostudio",
      userId: "user_x",
      studioId: null,
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      connectionKind: "local",
      credentialKind: "loopback_token",
      trustState: "local",
      scopes: ["chat"],
    };
    const engine = fakeEngine({
      studioId: runtimeStudioId,
      connectionKind: "local",
      serverId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
      serverNodeId: "server_0575dbce-9a28-4b09-9fb7-4f1fb136bbd9",
    });
    const ctx = createRequestContext(fakeContext(principal), engine);
    // 对齐分支要求 principal 自带 studioId，故 studio-less principal 保持 null，
    // 不会错误注入 runtime studioId；requestContext.studioId 仍由 runtime 兜底。
    expect(ctx.authPrincipal.studioId).toBeNull();
    expect(ctx.studioId).toBe(runtimeStudioId);
  });
});
