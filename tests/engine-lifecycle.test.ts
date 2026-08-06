import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { EngineLifecycle, resolveEngineRoots } from "../core/engine-lifecycle.ts";
import { userHomePath } from "../core/multiuser/paths.ts";

function makeFakeEngine() {
  return {
    hanakoHome: "",
    systemRoot: "",
    init: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

describe("EngineLifecycle", () => {
  let lc: EngineLifecycle;
  const factory = vi.fn();

  beforeEach(() => {
    factory.mockClear();
    factory.mockImplementation(() => Promise.resolve(makeFakeEngine()));
    lc = new EngineLifecycle({
      baseDir: "/tmp/hana",
      productDir: "/tmp/product",
      engineFactory: (userId: string) => {
        const e = factory();
        return e.then((eng: any) => {
          eng.hanakoHome = userHomePath(userId);
          return { engine: eng, hub: { id: "hub-" + userId } };
        });
      },
      sweepIntervalMs: 20,
      idleMs: 50,
    });
  });

  afterEach(async () => {
    await lc.drainAll();
  });

  it("use lazily creates a handle and acquire increments refCount", async () => {
    const h = await lc.use("alice");
    expect(h.state).toBe("ready");
    expect(h.refCount).toBe(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reuses the same handle across repeated use() (refCount)", async () => {
    const a = await lc.use("alice");
    const b = await lc.use("alice");
    expect(a).toBe(b);
    expect(a.refCount).toBe(2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("releaseRef decrements but does not dispose while refCount>0", async () => {
    await lc.use("alice");
    await lc.use("alice");
    await lc.releaseRef("alice");
    const h = await lc.use("alice");
    expect(h.refCount).toBe(2);
    expect(h.state).toBe("ready");
    expect(h.engine.dispose).not.toHaveBeenCalled();
  });

  it("keepAlive updates lastActivityAt", async () => {
    const h = await lc.use("alice");
    const before = h.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    lc.keepAlive("alice");
    expect(h.lastActivityAt).toBeGreaterThan(before);
  });

  it("idle (refCount>0, silent) disposes on sweep (GRILL Q3)", async () => {
    const h1 = await lc.use("alice"); // refCount=1
    h1.lastActivityAt = Date.now() - 10_000; // 模拟静默超时
    await (lc as any).sweep();
    expect(h1.state).toBe("disposed"); // 静默超时后 sweep 回收
    expect(h1.engine.dispose).toHaveBeenCalled();
    const h2 = await lc.use("alice"); // 重建
    expect(h2).not.toBe(h1);
    expect(h2.state).toBe("ready");
  });

  it("A-dispose does not kill B (GRILL Q5)", async () => {
    const a = await lc.use("alice");
    const b = await lc.use("bob");
    a.lastActivityAt = Date.now() - 10_000; // 仅 A 静默超时
    await (lc as any).sweep();
    expect(a.state).toBe("disposed");
    expect(b.state).toBe("ready");
    expect(b.engine.dispose).not.toHaveBeenCalled();
  });

  it("drainAll disposes everything", async () => {
    await lc.use("alice");
    await lc.use("bob");
    await lc.drainAll();
    expect(lc.activeCount()).toBe(0);
  });

  it("reuse after dispose rebuilds a fresh ready handle (data not lost at lifecycle level, G6)", async () => {
    const h = await lc.use("alice"); // refCount=1
    h.lastActivityAt = Date.now() - 10_000;
    await (lc as any).sweep(); // idle -> disposed
    expect(h.state).toBe("disposed");
    const h2 = await lc.use("alice"); // rebuild
    expect(h2).not.toBe(h);
    expect(h2.state).toBe("ready");
    expect(h2.refCount).toBe(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("resolveEngineRoots computes dual root (GRILL Q11-A)", () => {
    const r = resolveEngineRoots("/tmp/hana", "alice");
    expect(r.userDataRoot).toBe(path.join("/tmp/hana", "users", "alice"));
    expect(r.systemRoot).toBe(path.join("/tmp/hana", "system"));
  });
});
