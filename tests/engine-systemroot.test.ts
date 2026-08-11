import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EngineLifecycle, resolveEngineRoots } from "../core/engine-lifecycle.ts";
import { systemStoreDir } from "../shared/persistence/store-registry.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-sysroot-"));
}

/**
 * 轻量 fake engine factory：跳过真实 HanaEngine.init()，仅设 hanakoHome/systemRoot。
 * use() 只传 userId，factory 自行用 resolveEngineRoots 算路径。
 */
function makeFakeFactory(baseDir: string) {
  return async (userId: string) => {
    const { userDataRoot, systemRoot } = resolveEngineRoots(baseDir, userId);
    return {
      engine: {
        hanakoHome: userDataRoot,
        systemRoot,
        dispose: async () => {},
      },
      hub: {},
    };
  };
}

const lcList: EngineLifecycle[] = [];

afterEach(async () => {
  while (lcList.length) await lcList.pop()!.drainAll();
});

describe("engine systemRoot isolation (H1)", () => {
  it("user engine uses userDataRoot and shared systemRoot", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const h = await lc.use("u_a");
    expect(h.engine.hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
    expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
  });

  it("systemRoot equals systemStoreDir physical path", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const h = await lc.use("u_b");
    expect(h.engine.systemRoot).toBe(path.join(baseDir, "system"));
    expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
  });
});
