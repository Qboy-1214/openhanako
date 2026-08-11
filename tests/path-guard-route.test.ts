import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWithinUserRoot,
  PathGuardError,
  userHomePath,
} from "../core/multiuser/paths.ts";
import { EngineLifecycle, resolveEngineRoots } from "../core/engine-lifecycle.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m1-pathguard-"));
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

describe("assertWithinUserRoot (Task 4 path-guard)", () => {
  it("accepts a path inside the user's business root", () => {
    const baseDir = tmpBase();
    const userId = "u_a";
    const userRoot = path.join(baseDir, userHomePath(userId));
    const target = path.join(userRoot, "sessions", "x.json");
    expect(() => assertWithinUserRoot(userId, target, baseDir)).not.toThrow();
  });

  it("rejects a path in another user's business root", () => {
    const baseDir = tmpBase();
    const target = path.join(baseDir, userHomePath("u_b"), "sessions", "x.json");
    expect(() => assertWithinUserRoot("u_a", target, baseDir)).toThrow(PathGuardError);
  });

  it("rejects a path outside any users/ directory", () => {
    const baseDir = tmpBase();
    const target = path.join(baseDir, "system", "shared.json");
    expect(() => assertWithinUserRoot("u_a", target, baseDir)).toThrow(PathGuardError);
  });
});

describe("fs route path-guard (Task 4/7)", () => {
  it("per-user engine resolves session manifest only under own root", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const h = await lc.use("u_a");
    // hanakoHome 在 users/u_a 下，assertWithinUserRoot 应通过
    expect(() => assertWithinUserRoot("u_a", h.engine.hanakoHome, baseDir)).not.toThrow();
  });
});

describe("upload route path-guard (Task 4)", () => {
  it("per-user engine upload target stays within user root", async () => {
    const baseDir = tmpBase();
    const lc = new EngineLifecycle({ baseDir, productDir: baseDir, engineFactory: makeFakeFactory(baseDir) });
    lcList.push(lc);
    const h = await lc.use("u_b");
    expect(() => assertWithinUserRoot("u_b", h.engine.hanakoHome, baseDir)).not.toThrow();
    const other = path.join(baseDir, userHomePath("u_a"));
    expect(() => assertWithinUserRoot("u_b", other, baseDir)).toThrow(PathGuardError);
  });
});
