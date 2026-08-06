import path from "path";

/**
 * 多用户路径约定（GRILL Q11-A 模型）：
 * - 根父目录 baseDir = path.dirname(hanakoHome)，其中 hanakoHome = <root>/system
 * - 业务数据根 = baseDir/users/<userId>
 * - 系统级（共享）根 = baseDir/system  （= hanakoHome）
 *
 * 这些函数只做路径字符串构造；真实落盘由 store-registry 的
 * businessStoreDir / systemStoreDir 决定（见 Task 4.5）。
 */

/** 业务 home 相对段：users/<userId> */
export function userHomePath(userId: string): string {
  return path.join("users", userId);
}

/** 系统级 home 相对段（= hanakoHome 名） */
export function systemHomePath(): string {
  return "system";
}

/** 业务 store 根（绝对）：baseDir/users/<userId> */
export function resolveUserHome(baseDir: string, userId: string): string {
  return path.join(baseDir, userHomePath(userId));
}

/** 系统级 store 根（绝对）：baseDir/system */
export function resolveSystemHome(baseDir: string): string {
  return path.join(baseDir, systemHomePath());
}

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

/**
 * 仅校验 caller-selected 绝对路径落在该用户的业务根内（GRILL Q10）。
 * 引擎内部受管路径不需要逐个调用。
 * @throws PathGuardError 越界（如尝试写其他用户目录或 system 级）
 */
export function assertWithinUserRoot(userId: string, target: string, baseDir?: string): void {
  if (baseDir) {
    const allowed = resolveUserHome(baseDir, userId);
    const rel = path.relative(allowed, path.resolve(target));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathGuardError(
        `path ${target} escapes user root ${allowed}`
      );
    }
    return;
  }
  // 无 baseDir 时做最简校验：禁止跨越 users 边界
  const normalized = path.normalize(target);
  const marker = `${path.sep}users${path.sep}`;
  const idx = normalized.indexOf(marker);
  if (idx === -1) {
    throw new PathGuardError(`path ${target} is not within any users/ root`);
  }
  const after = normalized.slice(idx + marker.length);
  if (after.split(path.sep)[0] !== userId) {
    throw new PathGuardError(`path ${target} targets a different user`);
  }
}
