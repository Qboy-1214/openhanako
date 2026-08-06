import fs from "fs";
import path from "path";
import { systemStoreDir } from "../../shared/persistence/store-registry.ts";
import { userHomePath } from "../../core/multiuser/paths.ts";
import { setLocalAccountPasswordForUser } from "../../core/local-user-account.ts";

const USERS_JSON = "users.json";

function usersJsonPath(baseDir: string): string {
  return path.join(systemStoreDir(baseDir), USERS_JSON); // = <baseDir>/system/users.json
}

export interface RegisterInput {
  username: string;
  password: string;
  displayName: string;
}

export async function registerUser(
  baseDir: string,
  input: RegisterInput
): Promise<{ userId: string; scopes: string[] }> {
  const sysDir = systemStoreDir(baseDir);
  fs.mkdirSync(sysDir, { recursive: true });
  const lockPath = path.join(sysDir, ".users.lock");
  const release = await acquireLock(lockPath);
  try {
    const p = usersJsonPath(baseDir);
    let doc = fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, "utf8"))
      : { schemaVersion: 1, users: [], defaultUserId: null };
    if (!Array.isArray(doc.users)) doc.users = [];
    const existing = doc.users.find(
      (u: any) => u.username === input.username
    );
    if (existing) throw new Error("username_taken");
    const userId = `u_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const isFirst = doc.users.length === 0;
    const record = {
      userId,
      username: input.username,
      displayName: input.displayName,
      // 密码不存 users.json，交由 setLocalAccountPasswordForUser 写 system/local-user-auth.json
      scopes: isFirst ? ["SYSTEM_ADMIN"] : [],
      createdAt: Date.now(),
    };
    doc.users.push(record);
    if (isFirst) doc.defaultUserId = userId;
    // 原子写 users.json
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, p);
    // 写密码到 system/local-user-auth.json（按 userId，多用户安全）
    setLocalAccountPasswordForUser(sysDir, userId, input.password);
    // 建业务 home（userHomePath 返回 users/<userId>，需拼 baseDir）
    fs.mkdirSync(path.join(baseDir, userHomePath(userId)), { recursive: true });
    return { userId, scopes: record.scopes };
  } finally {
    release();
  }
}

export function readUsersJson(baseDir: string): any {
  const p = usersJsonPath(baseDir);
  return fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf8"))
    : { users: [], defaultUserId: null };
}

/** 只读：按用户名查用户（登录用） */
export function findUserByUsername(
  baseDir: string,
  username: string
): { userId: string; username: string; scopes: string[] } | null {
  const doc = readUsersJson(baseDir);
  return (
    doc.users.find((u: any) => u.username === username) ?? null
  );
}

/** 只读：查用户 scopes（/api/auth/me 用） */
export function getScopes(baseDir: string, userId: string): string[] {
  const doc = readUsersJson(baseDir);
  return doc.users.find((u: any) => u.userId === userId)?.scopes ?? [];
}

/** 简单文件锁：轮询直到拿到锁（dev 模式足够；M1 可换 atomically） */
async function acquireLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error("registration_lock_timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
