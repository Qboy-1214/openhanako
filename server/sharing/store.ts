/**
 * server/sharing/store.ts — M3 Sharing Market 系统级共享资产存储层
 *
 * 独立 SQLite 库，存放所有用户发布的工具/工作流元数据。
 * 系统级 store 根 = baseDir/system，db 文件 = system/shared-assets.db。
 *
 * 范式：仿 lib/memory/fact-store.ts —— 独立 .db 文件 + class 构造函数
 * new Database(dbPath) + PRAGMA user_version 迁移。
 */

import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { createModuleLogger } from "../../lib/debug-log.ts";

const log = createModuleLogger("sharing-store");

const require = createRequire(import.meta.url);
let BetterSqliteDatabase: any = null;

function loadBetterSqliteDatabase(): any {
  if (!BetterSqliteDatabase) {
    const mod = require("better-sqlite3");
    BetterSqliteDatabase = mod?.default || mod;
  }
  return BetterSqliteDatabase;
}

/** 当前 schema 版本。每次改表结构时递增并补 _migrate 的 case。 */
const SCHEMA_VERSION = 1;

/**
 * 资产类型（DB 用 asset_type 列，camelCase 在 rowToMeta 映射）。
 */
export type AssetKind = "tool" | "workflow";

/**
 * DB 行 → API 元数据的统一模型。
 * camelCase（API） ↔ snake_case（DB）映射在此一处完成。
 */
export interface SharedAssetMeta {
  id: string;
  ownerId: string;
  ownerHandle: string;
  kind: AssetKind;
  title: string;
  summary: string;
  homepageUrl?: string;
  forkedFrom?: string;
  publishedAt: string;
  updatedAt: string;
  installCount: number;
}

export interface PublishInput {
  id: string;
  ownerId: string;
  ownerHandle: string;
  kind: AssetKind;
  title: string;
  summary: string;
  homepageUrl?: string;
  forkedFrom?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToMeta(row: any): SharedAssetMeta {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerHandle: row.owner_handle,
    kind: row.asset_type,
    title: row.title,
    summary: row.summary,
    homepageUrl: row.homepage_url ?? undefined,
    forkedFrom: row.forked_from ?? undefined,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    installCount: row.install_count ?? 0,
  };
}

export class SharingAssetStore {
  private db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = loadBetterSqliteDatabase();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");
    this.db.pragma("temp_store = MEMORY");
    this._initSchema();
    this._migrate();
    this._prepareStatements();
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_assets (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT NOT NULL,
        owner_handle  TEXT NOT NULL DEFAULT '',
        asset_type    TEXT NOT NULL,
        title         TEXT NOT NULL,
        summary       TEXT NOT NULL DEFAULT '',
        homepage_url  TEXT,
        forked_from   TEXT,
        published_at  TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        install_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_shared_assets_owner ON shared_assets(owner_id);
      CREATE INDEX IF NOT EXISTS idx_shared_assets_kind  ON shared_assets(asset_type);
    `);
  }

  private _migrate(): void {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SCHEMA_VERSION) return;
    this.db.transaction(() => {
      let v = current;
      while (v < SCHEMA_VERSION) {
        switch (v) {
          case 0:
            // v0 → v1：初始 schema 已通过 _initSchema 建好，无需额外操作
            break;
          default:
            break;
        }
        v++;
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
    log.log(`sharing store schema migrated: v${current} → v${SCHEMA_VERSION}`);
  }

  private _stmt: Record<string, any> = {};
  private _prepareStatements(): void {
    this._stmt.insert = this.db.prepare(`
      INSERT OR REPLACE INTO shared_assets
        (id, owner_id, owner_handle, asset_type, title, summary, homepage_url, forked_from, published_at, updated_at, install_count)
      VALUES
        (@id, @owner_id, @owner_handle, @asset_type, @title, @summary, @homepage_url, @forked_from, @published_at, @updated_at,
         COALESCE((SELECT install_count FROM shared_assets WHERE id = @id), 0))
    `);
    this._stmt.get = this.db.prepare(`SELECT * FROM shared_assets WHERE id = ?`);
    this._stmt.delete = this.db.prepare(`DELETE FROM shared_assets WHERE id = ? AND owner_id = ?`);
    this._stmt.listByOwner = this.db.prepare(
      `SELECT * FROM shared_assets WHERE owner_id = ? ORDER BY updated_at DESC`,
    );
    this._stmt.listDiscoverable = this.db.prepare(
      `SELECT * FROM shared_assets ORDER BY install_count DESC, updated_at DESC`,
    );
    this._stmt.incInstall = this.db.prepare(
      `UPDATE shared_assets SET install_count = install_count + 1 WHERE id = ?`,
    );
  }

  /** 发布或更新资产。已存在 id 时以 owner_id 匹配后覆盖（更新时间刷新）。 */
  publish(input: PublishInput): SharedAssetMeta {
    const ts = nowIso();
    const existing: any = this._stmt.get.get(input.id);
    this._stmt.insert.run({
      id: input.id,
      owner_id: input.ownerId,
      owner_handle: input.ownerHandle,
      asset_type: input.kind,
      title: input.title,
      summary: input.summary,
      homepage_url: input.homepageUrl ?? null,
      forked_from: input.forkedFrom ?? null,
      published_at: existing?.published_at ?? ts,
      updated_at: ts,
    });
    return this.get(input.id)!;
  }

  get(id: string): SharedAssetMeta | null {
    const row = this._stmt.get.get(id);
    return row ? rowToMeta(row) : null;
  }

  /** 删除：仅当 owner_id 匹配，返回是否删除成功。 */
  unpublish(id: string, ownerId: string): boolean {
    const res = this._stmt.delete.run(id, ownerId);
    return res.changes > 0;
  }

  listByOwner(ownerId: string): SharedAssetMeta[] {
    return this._stmt.listByOwner.all(ownerId).map(rowToMeta);
  }

  listDiscoverable(): SharedAssetMeta[] {
    return this._stmt.listDiscoverable.all().map(rowToMeta);
  }

  /** 安装计数 +1（install 成功后调用）。 */
  bumpInstallCount(id: string): void {
    this._stmt.incInstall.run(id);
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // 忽略关闭异常
    }
  }
}
