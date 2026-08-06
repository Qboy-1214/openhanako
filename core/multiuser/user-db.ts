import {
  businessStoreDir,
  systemStoreDir,
} from "../../shared/persistence/store-registry.ts";

/**
 * 业务/系统分库工厂（GRILL Q9/Q11-A）。
 * 真实落盘由 store-registry 既有注册路径处理；本工厂只负责「算对 baseDir」：
 * - 业务 store（agents/sessions/memory/...）baseDir = users/<userId>
 * - 系统级 store（users/auth/sessions/grants/...）baseDir = system
 */
export const SYSTEM_STORE_KINDS = new Set([
  "users",
  "auth",
  "web-sessions",
  "grants",
  "server-node",
  "data-epoch",
  "provider-catalog",
]);

export interface ScopedStore {
  kind: string;
  baseDir: string;
}

export function makeBusinessStore(
  baseDir: string,
  userId: string,
  kind: string
): ScopedStore {
  return { kind, baseDir: businessStoreDir(baseDir, userId) };
}

export function makeSystemStore(baseDir: string, kind: string): ScopedStore {
  if (!SYSTEM_STORE_KINDS.has(kind)) {
    throw new Error(`kind ${kind} is not a system-scoped store`);
  }
  return { kind, baseDir: systemStoreDir(baseDir) };
}
