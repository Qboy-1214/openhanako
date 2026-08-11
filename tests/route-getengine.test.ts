import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EngineLifecycle, resolveEngineRoots } from "../core/engine-lifecycle.ts";
import { userEngineMiddleware } from "../server/composition/user-engine-middleware.ts";
import { createMockContext } from "./test-utils/mock-context.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-getengine-"));
}

/** 跳过真实 HanaEngine.init()，仅返回含 hanakoHome/systemRoot 的 fake engine。*/
function makeFakeFactory(baseDir: string) {
  return async (userId: string) => {
    const { userDataRoot, systemRoot } = resolveEngineRoots(baseDir, userId);
    return {
      engine: { hanakoHome: userDataRoot, systemRoot, dispose: async () => {} },
      hub: {},
    };
  };
}

const lcList: EngineLifecycle[] = [];

afterEach(async () => {
  while (lcList.length) {
    await lcList.pop()!.drainAll();
  }
});

describe("userEngineMiddleware injects per-user engine (Task 2 / F1)", () => {
  it("sets c.get('engine') to a per-user engine with correct hanakoHome", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const mw = userEngineMiddleware(lc);

    const c = createMockContext({ userId: "u_a" });
    let captured: any = null;
    await mw(c, async () => {
      captured = c.get("engine");
    });

    expect(captured).not.toBeNull();
    expect(captured.hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
  });

  it("different users get different hanakoHome, same systemRoot (H1)", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const mw = userEngineMiddleware(lc);

    const engines: Record<string, any> = {};
    for (const userId of ["u_a", "u_b"]) {
      const c = createMockContext({ userId });
      await mw(c, async () => {
        engines[userId] = c.get("engine");
      });
    }

    expect(engines["u_a"].hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
    expect(engines["u_b"].hanakoHome).toBe(path.join(baseDir, "users", "u_b"));
    expect(engines["u_a"].systemRoot).toBe(engines["u_b"].systemRoot);
  });

  it("rejects unauthenticated request with 401", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const mw = userEngineMiddleware(lc);

    const c = createMockContext({ userId: null });
    await mw(c, async () => {
      throw new Error("should not reach handler");
    });

    expect(c.res.status).toBe(401);
  });
});
