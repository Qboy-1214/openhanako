/**
 * docker.ts — Linux Docker 沙盒（M2-3 第四种 exec 后端）
 *
 * 与 bwrap 同构：返回符合 Pi SDK BashOperations.exec 接口的函数。
 * 复用 spawnAndStream 的 Pi SDK 契约（cwd/env/onData/signal/timeout）。
 * 通过 `docker run --rm` 把命令脚本挂载进容器执行，cwd 与额外挂载按策略绑定。
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { spawnAndStream } from "./exec-helper.ts";
import { writeScript, cleanup } from "./script.ts";

/**
 * 创建 Docker 沙盒化的 exec 函数
 * @param {object} policy  从 deriveSandboxPolicy() 得到
 * @param {object} [options]
 * @param {() => string[]} [options.getExternalReadPaths]
 * @param {() => boolean} [options.getSandboxNetworkEnabled]
 * @param {string} [options.image] 容器镜像（默认 ubuntu:22.04）
 * @param {string[]} [options.additionalMounts] 额外部署卷 [-v src:dst]
 * @returns {(command, cwd, opts) => Promise<{exitCode}>}
 */
export function createDockerExec(
  policy: any,
  {
    getExternalReadPaths,
    getSandboxNetworkEnabled,
    image = process.env.HANAKO_SANDBOX_IMAGE || "ubuntu:22.04",
    additionalMounts = [],
  }: {
    getExternalReadPaths?: () => string[];
    getSandboxNetworkEnabled?: () => boolean;
    image?: string;
    additionalMounts?: string[];
  } = {},
) {
  return async (command: string, cwd: string, { onData, signal, timeout, env }: any) => {
    const { scriptPath } = writeScript(command, cwd);
    const args = buildDockerArgs(policy, {
      cwd,
      env,
      image,
      additionalMounts,
      allowNetwork: typeof getSandboxNetworkEnabled === "function"
        ? getSandboxNetworkEnabled()
        : true,
      externalReadPaths: typeof getExternalReadPaths === "function" ? getExternalReadPaths() : [],
      runtimeReadPaths: [scriptPath],
    });
    try {
      return await spawnAndStream(
        "docker",
        [...args, "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath);
    }
  };
}

const SYSTEM_READONLY_PATHS = [
  "/bin", "/sbin", "/usr", "/lib", "/lib64", "/opt",
  "/nix/store", "/etc/alternatives", "/etc/ssl", "/etc/ca-certificates",
  "/etc/pki", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
  "/etc/hosts", "/etc/localtime",
];

function existingPaths(paths?: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths || []) {
    if (!p || seen.has(p) || !fs.existsSync(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function dockerMount(args: string[], source: string, target: string, ro = false) {
  args.push("-v", `${source}:${target}${ro ? ":ro" : ""}`);
}

/**
 * 构造 docker run 参数。采用 allowlist 挂载：系统运行时只读、cwd 可写绑定、
 * 授权外部只读路径按策略挂载、deny 路径用 tmpfs 遮蔽。
 */
export function buildDockerArgs(
  policy: any,
  {
    cwd,
    env,
    image,
    additionalMounts = [],
    allowNetwork = true,
    externalReadPaths = [],
    runtimeReadPaths = [],
  }: {
    cwd?: string;
    env?: Record<string, string>;
    image: string;
    additionalMounts?: string[];
    allowNetwork?: boolean;
    externalReadPaths?: string[];
    runtimeReadPaths?: string[];
  } = {},
) {
  const readAll = policy?.allowExternalReads !== false;
  const args = ["run", "--rm"];

  if (!allowNetwork) args.push("--network", "none");

  // 系统运行时只读
  for (const p of existingPaths(SYSTEM_READONLY_PATHS)) dockerMount(args, p, p, true);

  // cwd 可写绑定
  if (cwd && fs.existsSync(cwd)) {
    dockerMount(args, cwd, cwd, false);
    args.push("-w", cwd);
  }

  // 可写路径
  for (const p of existingPaths(policy?.writablePaths)) dockerMount(args, p, p, false);
  // 只读授权路径
  for (const p of existingPaths([...(policy?.readablePaths || []), ...externalReadPaths, ...runtimeReadPaths])) {
    dockerMount(args, p, p, true);
  }
  // 受保护路径：覆盖为只读
  for (const p of existingPaths(policy?.protectedPaths)) dockerMount(args, p, p, true);
  // deny 路径：用 tmpfs 遮蔽
  for (const p of policy?.denyReadPaths || []) {
    if (!fs.existsSync(p)) continue;
    try {
      if (fs.statSync(p).isDirectory()) args.push("--tmpfs", p);
      else dockerMount(args, "/dev/null", p, true);
    } catch {}
  }

  // 用户缓存遮蔽（避免回落真实 HOME 缓存）
  const hostHome = env?.HOME || os.homedir();
  for (const d of [path.join(hostHome, ".cache"), path.join(hostHome, ".npm")]) {
    const isWritable = (policy?.writablePaths || []).some(
      (w: string) => d === w || d.startsWith(w + path.sep),
    );
    if (!isWritable && fs.existsSync(d)) args.push("--tmpfs", d);
  }

  // 额外挂载（部署态注入）
  for (const m of additionalMounts) args.push("-v", m);

  args.push(image);
  return args;
}

/** M2-3 §6.1：是否运行在容器内（docker/bwrap 嵌套检测）。 */
export function isInsideContainer(): boolean {
  if (fs.existsSync("/.dockerenv")) return true;
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|containerd|kubepods/.test(cgroup);
  } catch {
    return false;
  }
}

export type SandboxBackend = "auto" | "docker" | "bwrap";

/**
 * M2-3 §6.1：选择沙盒后端。
 * - env=HANAKO_SANDBOX_BACKEND 显式指定（docker/bwrap）时优先。
 * - auto：若已运行在容器内（嵌套），选 bwrap（容器内一般无 docker 可用）；
 *   否则在 docker 可用时选 docker，否则回退 bwrap。
 */
export function selectSandboxBackend(env?: SandboxBackend): "docker" | "bwrap" {
  const configured = (env ?? (process.env.HANAKO_SANDBOX_BACKEND as SandboxBackend)) || "auto";
  if (configured === "docker") return "docker";
  if (configured === "bwrap") return "bwrap";
  // auto：仅 Linux 考虑 docker 后端（macOS/win 保持 seatbelt/restricted-token 路径）
  if (process.platform !== "linux") return "bwrap";
  if (isInsideContainer()) return "bwrap"; // 已是容器内，避免 docker-in-docker，用 bwrap
  try {
    execFileSync("which", ["docker"], { stdio: "ignore" });
    return "docker";
  } catch {
    return "bwrap";
  }
}
