/**
 * P0-2 广播 owner 过滤决策（纯函数，便于单测）。
 * - ownerUserId 为 undefined → 全局事件（系统级，无 owner 维度）→ 所有 client 都可收。
 * - ownerUserId 为 string → 仅 owner 用户 client 可收；其他用户收不到（跨用户隔离）。
 * - ownerUserId 为 null → 调用方已 fail-closed 丢弃，不会传入此值。
 */
export function matchesBroadcastOwner(
  client: { principal?: { userId?: string } } | undefined | null,
  ownerUserId?: string | null,
): boolean {
  if (ownerUserId && client?.principal?.userId !== ownerUserId) return false;
  return true;
}
