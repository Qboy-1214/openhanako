import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EngineLifecycle } from "../core/engine-lifecycle.ts";
import { systemStoreDir } from "../shared/persistence/store-registry.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-sysroot-"));
}

const bases: string[] = [];

afterEach(() => {
  // best-effort; engines 由 drainAll 释放
});

describe("engine systemRoot isolation (H1)", () => {
  it("user engine uses userDataRoot and shared systemRoot", async () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    try {
      const h = await lc.use("u_a");
      expect(h.engine.hanakoHome).toBe(path.join(baseDir, "users", "u_a"));
      expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
    } finally {
      await lc.drainAll();
    }
  });

  it("systemRoot equals systemStoreDir physical path", async () => {
    const baseDir = tmpBase();
    bases.push(baseDir);
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir });
    try {
      const h = await lc.use("u_b");
      expect(h.engine.systemRoot).toBe(path.join(baseDir, "system"));
      expect(h.engine.systemRoot).toBe(systemStoreDir(baseDir));
    } finally {
      await lc.drainAll();
    }
  });
});
