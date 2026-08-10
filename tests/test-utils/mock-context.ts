/**
 * 最小 Hono Context stub，满足 userEngineMiddleware 的调用契约：
 * - c.get("authPrincipal") -> principal（由 readAuthPrincipal 读取）
 * - c.set(key, val) / c.get(key) -> 通用 store
 * - c.json(body, status) -> 设置 res.status
 * - c.req / c.res 基础字段
 */
export function createMockContext(opts: { userId: string | null; scopes?: string[] }): any {
  const store = new Map<string, any>();
  const principal = opts.userId
    ? { userId: opts.userId, principalId: opts.userId, scopes: opts.scopes || ["USER"] }
    : null;
  store.set("authPrincipal", principal);
  const res: any = { status: 200, body: null };
  return {
    req: { header: () => "" },
    res,
    get(key: string) {
      return store.get(key);
    },
    set(key: string, val: any) {
      store.set(key, val);
    },
    json(body: any, status?: number) {
      res.body = body;
      if (typeof status === "number") res.status = status;
      return body;
    },
  };
}
