/**
 * server/sharing/index.ts — M3 Sharing Market 核心业务逻辑
 *
 * SharingMarket 负责：
 *  - publish：把用户工具/工作流快照存入 shared/<id>/，并在系统级 shared_assets store 登记元数据
 *  - unpublish / listMine / discover / install
 *
 * 与引擎解耦：SharingMarket 只依赖 SharingAssetStore + baseDir + 可选的
 * accounts(catalogProvider) 扩展点（GRILL Q9）。运行时由 server/index.ts
 * 构造单例并注入路由。
 */

import * as fs from "fs";
import * as path from "path";
import { SharingAssetStore, type AssetKind, type SharedAssetMeta } from "./store.ts";
import { assertWithinUserRoot } from "../../core/multiuser/paths.ts";

/** 文件系统安全名：Windows/类 Unix 下均可用作目录名（去掉 : @ / \\ 等非法字符）。 */
export function fsSafe(name: string): string {
  return name.replace(/[:@/\\]/g, "_");
}

export interface DiscoverItem extends SharedAssetMeta {
  /** 扩展点：第三方目录可附加额外字段（GRILL Q9），默认空。 */
  extra?: Record<string, unknown>;
}

export interface SharingMarketOptions {
  /** 解析 ownerHandle：默认回退到 userId。可由上层注入真实 profile/account 解析。 */
  resolveHandle?: (userId: string) => string;
  /** discover 扩展点：返回额外目录项，拼接到本地 store 的结果之后。 */
  catalogProvider?: () => Promise<DiscoverItem[]>;
}

export interface PublishResult {
  id: string;
  status: "published";
}

export interface InstallResult {
  id: string;
  status: "installed";
  localId: string;
}

export class SharingMarket {
  readonly store: SharingAssetStore;
  readonly baseDir: string;
  private readonly opts: SharingMarketOptions;

  constructor(store: SharingAssetStore, baseDir: string, opts: SharingMarketOptions = {}) {
    this.store = store;
    this.baseDir = baseDir;
    this.opts = opts;
  }

  private _userHome(userId: string): string {
    return path.join(this.baseDir, "users", userId);
  }

  private _sharedDir(assetId: string): string {
    return path.join(this.baseDir, "system", "shared", fsSafe(assetId));
  }

  private _resolveHandle(userId: string): string {
    return this.opts.resolveHandle?.(userId) ?? userId;
  }

  /**
   * 发布资产。sourceContent 为资产源（tool src 或 workflow graph JSON 字符串）。
   * 快照写入 baseDir/system/shared/<id>/，元数据登记进系统级 store。
   */
  publish(input: {
    kind: AssetKind;
    sourceId: string;
    title: string;
    summary: string;
    homepageUrl?: string;
    forkedFrom?: string;
    ownerId: string;
    sourceContent: string;
  }): PublishResult {
    const id = input.sourceId.startsWith(`${input.kind}:`)
      ? input.sourceId
      : `${input.kind}:${input.sourceId}`;
    const dir = this._sharedDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const snapshotName = input.kind === "workflow" ? "graph.json" : "src";
    fs.writeFileSync(path.join(dir, snapshotName), input.sourceContent);

    this.store.publish({
      id,
      ownerId: input.ownerId,
      ownerHandle: this._resolveHandle(input.ownerId),
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      homepageUrl: input.homepageUrl,
      forkedFrom: input.forkedFrom,
    });
    return { id, status: "published" };
  }

  unpublish(id: string, ownerId: string): boolean {
    return this.store.unpublish(id, ownerId);
  }

  listMine(ownerId: string): SharedAssetMeta[] {
    return this.store.listByOwner(ownerId);
  }

  async discover(): Promise<DiscoverItem[]> {
    const local = this.store.listDiscoverable().map((m) => ({ ...m }) as DiscoverItem);
    const extra = this.opts.catalogProvider ? await this.opts.catalogProvider() : [];
    return [...local, ...extra];
  }

  /**
   * 安装资产到调用者（ownerId）的业务根。
   * - tool：把源内容落盘到 tools/<localId>/ 并经引擎热注册（sandboxed）。
   * - workflow：把 graph.json 落盘到 workflows/<localId>/。
   * 返回本地 id 与状态。
   */
  install(id: string, ownerId: string): InstallResult {
    const meta = this.store.get(id);
    if (!meta) throw Object.assign(new Error("asset_not_found"), { status: 404 });
    const sharedDir = this._sharedDir(id);
    if (!fs.existsSync(sharedDir)) throw Object.assign(new Error("asset_source_missing"), { status: 410 });

    const localId = fsSafe(`${id}@${ownerId}`);
    const userHome = this._userHome(ownerId);
    assertWithinUserRoot(ownerId, userHome, this.baseDir);

    if (meta.kind === "workflow") {
      const graph = fs.readFileSync(path.join(sharedDir, "graph.json"), "utf8");
      const wfDir = path.join(userHome, "workflows", localId);
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(path.join(wfDir, "graph.json"), graph);
    } else {
      const src = fs.readFileSync(path.join(sharedDir, "src"), "utf8");
      const toolDir = path.join(userHome, "tools", localId);
      fs.mkdirSync(toolDir, { recursive: true });
      const def = {
        id: localId,
        name: localId,
        description: meta.summary,
        runtime: "js" as const,
        src,
        forkedFrom: id,
        sandboxed: true,
      };
      fs.writeFileSync(path.join(toolDir, "manifest.json"), JSON.stringify(def, null, 2));
      fs.writeFileSync(path.join(toolDir, "src"), src);
    }

    this.store.bumpInstallCount(id);
    return { id, status: "installed", localId };
  }
}

export interface MarketTestDeps {
  store: SharingAssetStore;
  baseDir: string;
  opts?: SharingMarketOptions;
}

/** 测试工厂：直接构造 SharingMarket（绕过 server 单例装配）。 */
export function makeMarket(deps: MarketTestDeps): SharingMarket {
  return new SharingMarket(deps.store, deps.baseDir, deps.opts);
}
