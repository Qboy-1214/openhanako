import { describe, it, expect, vi } from "vitest";
import { bindEngineToWs } from "../server/ws/engine-ws-binding.ts";

function fakeWs() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  return {
    principal: { userId: "u_a" },
    engine: undefined as any,
    hub: undefined as any,
    on(event: string, cb: (...a: any[]) => void) { handlers[event] = cb; },
    close() {},
    _handlers: handlers,
  };
}

function fakeCtx() {
  return { get: (k: string) => (k === "authPrincipal" ? { userId: "u_a" } : undefined) };
}

describe("bindEngineToWs P0-1 onReady", () => {
  it("calls onReady after acquire completes (flush hook for first-message queue)", async () => {
    const ws = fakeWs();
    const ctx = fakeCtx();
    const lifecycle = {
      use: (userId: string) => Promise.resolve({ engine: { hanakoHome: "x" }, hub: {} }),
      keepAlive: () => {},
      releaseRef: () => {},
    };
    const onReady = vi.fn();
    bindEngineToWs(ws as any, lifecycle as any, ctx as any, { onReady });

    // acquire 是异步的；onReady 不应立即调用
    expect(onReady).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0)); // flush microtask
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(ws);
    expect(ws.engine).toBeDefined(); // engine 已挂载
    expect(ws.hub).toBeDefined();
  });

  it("does NOT fall back to a global engine on failure (closes instead)", async () => {
    const ws = fakeWs();
    const ctx = fakeCtx();
    const lifecycle = {
      use: () => Promise.reject(new Error("acquire failed")),
      keepAlive: () => {},
      releaseRef: () => {},
    };
    const closeSpy = vi.spyOn(ws, "close");
    bindEngineToWs(ws as any, lifecycle as any, ctx as any, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(closeSpy).toHaveBeenCalled(); // 失败时关闭，绝不挂全局 engine
  });
});
