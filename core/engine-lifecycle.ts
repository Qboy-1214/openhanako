import path from "path";
import { userHomePath, systemHomePath } from "./multiuser/paths.ts";

// 注意：HanaEngine / Hub 在 defaultFactory 内动态 import，
// 避免模块顶层静态依赖 engine.ts（及其庞大依赖图），
// 使注入 fake factory 的测试无需转译整个引擎。

export interface UserEngineHandle {
  userId: string;
  engine: any;
  hub: any;
  refCount: number;
  lastActivityAt: number;
  state: "starting" | "ready" | "draining" | "disposed";
}

export interface EngineLifecycleOptions {
  /** 根父目录：baseDir/system 为 system 根、baseDir/users/<id> 为业务根 */
  baseDir: string;
  productDir: string;
  appVersion?: string;
  builtinMediaAdapters?: readonly any[];
  sweepIntervalMs?: number;
  idleMs?: number;
  /**
   * 引擎工厂（GRILL Q5：必须 new+init+new Hub）。
   * 缺省为生产实现；测试可注入 fake。
   */
  engineFactory?: (userId: string, opts: any) => Promise<any>;
}

/** 由 baseDir + userId 解析双根（GRILL Q11-A） */
export function resolveEngineRoots(baseDir: string, userId: string): { userDataRoot: string; systemRoot: string } {
  return {
    userDataRoot: path.join(baseDir, userHomePath(userId)),
    systemRoot: path.join(baseDir, systemHomePath()),
  };
}

const DEFAULT_SWEEP_MS = 60_000;
const DEFAULT_IDLE_MS = 30 * 60_000;

export class EngineLifecycle {
  private opts: EngineLifecycleOptions;
  private handles = new Map<string, UserEngineHandle>();
  private creating = new Map<string, Promise<UserEngineHandle>>();
  private sweepTimer: any = null;

  constructor(opts: EngineLifecycleOptions) {
    this.opts = opts;
    const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.sweepTimer = setInterval(() => void this.sweep(), sweep);
  }

  private async defaultFactory(userId: string): Promise<any> {
    const { userDataRoot, systemRoot } = resolveEngineRoots(this.opts.baseDir, userId);
    const { HanaEngine } = await import("./engine.ts");
    const { Hub } = await import("../hub/index.ts");
    const engine = new HanaEngine({
      hanakoHome: userDataRoot,
      systemRoot,
      productDir: this.opts.productDir,
      appVersion: this.opts.appVersion,
      builtinMediaAdapters: this.opts.builtinMediaAdapters,
    });
    await engine.init?.({});
    const hub = new Hub({ engine });
    return { engine, hub };
  }

  /** acquire：refCount++；无则 new+init+new Hub（GRILL Q4/Q5）。并发 use 同一 userId 复用同一创建。 */
  async use(userId: string): Promise<UserEngineHandle> {
    let h = this.handles.get(userId);
    if (!h || h.state === "disposed") {
      const inFlight = this.creating.get(userId);
      if (inFlight) return this.afterAcquire(await inFlight);
      const factory = this.opts.engineFactory ?? ((id: string) => this.defaultFactory(id));
      const p = (async () => {
        const { engine, hub } = await factory(userId);
        const handle: UserEngineHandle = {
          userId,
          engine,
          hub,
          refCount: 0,
          lastActivityAt: Date.now(),
          state: "ready",
        };
        this.handles.set(userId, handle);
        return handle;
      })();
      this.creating.set(userId, p);
      try {
        return this.afterAcquire(await p);
      } finally {
        this.creating.delete(userId);
      }
    }
    return this.afterAcquire(h);
  }

  private afterAcquire(h: UserEngineHandle): UserEngineHandle {
    h.refCount += 1;
    h.lastActivityAt = Date.now();
    return h;
  }

  /** 有实际活动时续命（HTTP 请求 / WS 往来消息） */
  keepAlive(userId: string): void {
    const h = this.handles.get(userId);
    if (h) h.lastActivityAt = Date.now();
  }

  /** refCount--；归零不立即 dispose，仅启动空闲计时（GRILL Q3/Q4） */
  async releaseRef(userId: string): Promise<void> {
    const h = this.handles.get(userId);
    if (!h) return;
    h.refCount = Math.max(0, h.refCount - 1);
    if (h.state === "draining") h.state = "ready";
  }

  private async sweep(): Promise<void> {
    const idle = this.opts.idleMs ?? DEFAULT_IDLE_MS;
    const now = Date.now();
    for (const h of this.handles.values()) {
      // R6 修复：移除 `refCount > 0` 限制——只要引擎处于 ready 且 idle 超时即回收，
      // 使 refCount===0（请求/WS 全部释放）的引擎也能被回收。WS 挂着时由 keepAlive 续命
      // （lastActivityAt 被刷新），不会在 idle 内误回收。
      if (h.state === "ready" && now - h.lastActivityAt > idle) {
        await this.disposeHandle(h);
      }
    }
  }

  private async disposeHandle(h: UserEngineHandle): Promise<void> {
    h.state = "draining";
    try {
      await h.engine?.dispose?.();
    } finally {
      h.state = "disposed";
    }
  }

  async drainAll(): Promise<void> {
    for (const h of this.handles.values()) {
      if (h.state !== "disposed") await this.disposeHandle(h);
    }
    this.handles.clear();
  }

  acquireCount(userId: string): number {
    return this.handles.get(userId)?.refCount ?? 0;
  }

  activeCount(): number {
    let n = 0;
    for (const h of this.handles.values()) if (h.state === "ready") n += 1;
    return n;
  }
}
