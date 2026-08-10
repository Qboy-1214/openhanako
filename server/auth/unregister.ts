import fs from "fs";
import path from "path";
import { systemStoreDir } from "../../shared/persistence/store-registry.ts";
import { userHomePath } from "../../core/multiuser/paths.ts";
import { removeLocalAccountPasswordForUser } from "../../core/local-user-account.ts";
import { readUsersJson, findUserByUsername } from "./register.ts";

const USERS_JSON = "users.json";

function usersJsonPath(baseDir: string): string {
  return path.join(systemStoreDir(baseDir), USERS_JSON);
}

/** 末位系统管理员删除被拒 */
export class LastAdminError extends Error {
  constructor(message = "cannot delete the last system admin") {
    super(message);
    this.name = "LastAdminError";
  }
}

/** 当前系统管理员数量（scopes 含 SYSTEM_ADMIN） */
export function countSystemAdmins(baseDir: string): number {
  const doc = readUsersJson(baseDir);
  return (doc.users || []).filter(
    (u: any) => Array.isArray(u.scopes) && u.scopes.includes("SYSTEM_ADMIN")
  ).length;
}

/**
 * 软删：标记 disabled，保留业务数据与密码哈希，可恢复。
 * 引擎释放交给调用方（route 层经 EngineLifecycle.releaseRef + drainAll）。
 */
export async function softDeleteUser(baseDir: string, userId: string): Promise<void> {
  const doc = readUsersJson(baseDir);
  const user = (doc.users || []).find((u: any) => u.userId === userId);
  if (!user) throw new Error("user_not_found");
  user.disabled = true;
  user.disabledAt = Date.now();
  const p = usersJsonPath(baseDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * 硬删：先校验末位管理员防护；通过则删用户记录、业务 home 目录、密码哈希。
 */
export async function hardDeleteUser(baseDir: string, userId: string): Promise<void> {
  const doc = readUsersJson(baseDir);
  const idx = (doc.users || []).findIndex((u: any) => u.userId === userId);
  if (idx === -1) throw new Error("user_not_found");
  const user = doc.users[idx];
  if (Array.isArray(user.scopes) && user.scopes.includes("SYSTEM_ADMIN")) {
    if (countSystemAdmins(baseDir) <= 1) {
      throw new LastAdminError();
    }
  }

  // 删业务 home
  const userHome = path.join(baseDir, userHomePath(userId));
  if (fs.existsSync(userHome)) {
    fs.rmSync(userHome, { recursive: true, force: true });
  }
  // 删密码哈希
  const sysDir = systemStoreDir(baseDir);
  try {
    removeLocalAccountPasswordForUser(sysDir, userId);
  } catch {
    /* 无密码哈希时忽略 */
  }

  // 删用户记录
  doc.users.splice(idx, 1);
  const p = usersJsonPath(baseDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, p);
}
