import * as path from "path";

/**
 * P0-2 Step 0 — sessionPath → ownerUserId 映射。
 *
 * 两条解析路径：
 *  1. 运行时索引（OWNER_INDEX）：由 registerSessionOwner 在 session 建立时补写，
 *     覆盖无 users/ 前缀的会话形态（bridge/*、agent 会话等）。
 *  2. 前缀回退：per-user 会话路径形如 users/<userId>/sessions/...，直接正则提取。
 *
 * 解析失败（无 owner）返回 null，由调用方按 fail-closed 处理（丢弃 + warn）。
 */

const OWNER_INDEX = new Map<string, string>(); // normalize(sessionPath) -> userId

export function registerSessionOwner(sessionPath: string | null | undefined, userId: string) {
  if (!sessionPath || !userId) return;
  OWNER_INDEX.set(normalize(sessionPath), userId);
}

export function resolveOwnerUserId(sessionPath: string | null | undefined): string | null {
  if (!sessionPath) return null;
  const norm = normalize(sessionPath);
  const idx = OWNER_INDEX.get(norm);
  if (idx) return idx;
  // 回退：per-user 前缀解析
  const m = norm.match(/users[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : null;
}

function normalize(p: string): string {
  return p.split(path.sep).join("/").replace(/\/$/, "");
}
