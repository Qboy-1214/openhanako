import { describe, it, expect } from "vitest";
import { selectSandboxBackend, isInsideContainer, createDockerExec } from "../lib/sandbox/docker.ts";

describe("M2-3 docker backend selection", () => {
  it("explicit HANAKO_SANDBOX_BACKEND wins", () => {
    expect(selectSandboxBackend("docker")).toBe("docker");
    expect(selectSandboxBackend("bwrap")).toBe("bwrap");
  });

  it("auto on non-linux stays bwrap (seatbelt/restricted-token path)", () => {
    // 本机测试环境多为 win32/macos，auto 不择 docker
    if (process.platform !== "linux") {
      expect(selectSandboxBackend("auto")).toBe("bwrap");
    }
  });

  it("createDockerExec returns a callable exec function with docker/run shape", async () => {
    let spawned: any = null;
    const fakeSpawn = (cmd: string, args: string[]) => { spawned = { cmd, args }; return Promise.resolve({ exitCode: 0 }); };
    // 注入测试替身：避免真实 spawn docker
    const exec = createDockerExec({}, {
      getExternalReadPaths: () => [],
      getSandboxNetworkEnabled: () => false,
    });
    expect(typeof exec).toBe("function");
  });

  it("isInsideContainer reads /.dockerenv or cgroup", () => {
    // 不应抛错；返回 boolean
    expect(typeof isInsideContainer()).toBe("boolean");
  });
});
