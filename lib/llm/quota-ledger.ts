/**
 * M5 §2.3 — 按用户 LLM 配额账本（仅系统兜底模型通道）。
 *
 * 设计边界（见 plan C1）：
 *  - 仅对"系统兜底模型"按 userId 独立累计每日消耗；用户自添模型不受限。
 *  - 与 usage-ledger（记账）是两独立账本：本账本只管配额拦截，不代替用量统计。
 *  - 逻辑日：04:00 起算（复用 current-status-tool 的同款规则），时区由
 *    HANA_QUOTA_TZ 控制（默认 UTC）。跨逻辑日惰性重置（按"逻辑日+userId"分桶）。
 *  - 单实例前提：无定时器，重置在读取时按当前逻辑日惰性判定。
 *
 * 与 §2.4 failover 的关联：isFallbackModel 复用 failover 的 fallbackModelResolved
 * 解析结果（D1 启动期缓存），保证"限流识别对象"与"failover 目标"完全一致。
 */
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const QUOTA_LEDGER_FILE = "quota-ledger.json";
const STORAGE_VERSION = 1;
const DAY_BOUNDARY_HOUR = 4; // 逻辑日 04:00 起算

/** 兜底每日配额（token 数）。0 = 无上限（仍记账）。 */
function fallbackDailyQuota(): number {
  const raw = process.env.HANA_FALLBACK_QUOTA_DAILY_TOKENS;
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 配额逻辑日时区（默认 UTC）。 */
function quotaTimeZone(): string {
  const raw = process.env.HANA_QUOTA_TZ;
  if (typeof raw === "string" && raw.trim()) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw.trim() }).format(new Date());
      return raw.trim();
    } catch {
      /* 非法时区回退 UTC */
    }
  }
  return "UTC";
}

/** 逻辑日 key（YYYY-MM-DD），04:00 起算，按指定时区。 */
export function logicalDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  let year = Number(map.year);
  let month = Number(map.month);
  let day = Number(map.day);
  if (Number(map.hour) < DAY_BOUNDARY_HOUR) {
    const prev = new Date(Date.UTC(year, month - 1, day));
    prev.setUTCDate(prev.getUTCDate() - 1);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeModelRef(modelRef: any): { id?: string; provider?: string } | null {
  if (!modelRef) return null;
  if (typeof modelRef === "string") {
    const [provider, id] = modelRef.includes("/") ? modelRef.split("/") : [undefined, modelRef];
    return { id, provider };
  }
  if (typeof modelRef === "object") {
    return { id: modelRef.id, provider: modelRef.provider };
  }
  return null;
}

interface QuotaLedgerData {
  version: number;
  buckets: Record<string, Record<string, number>>; // [logicalDay][userId] = tokens
}

export class QuotaLedger {
  private _hanakoHome: string;
  private _data: QuotaLedgerData;
  private _loaded = false;
  private _fallbackModel: { id?: string; provider?: string } | null = null;

  constructor(hanakoHome: string) {
    if (!hanakoHome) throw new Error("QuotaLedger requires hanakoHome");
    this._hanakoHome = hanakoHome;
    this._data = { version: STORAGE_VERSION, buckets: {} };
  }

  private get ledgerPath() {
    return path.join(this._hanakoHome, QUOTA_LEDGER_FILE);
  }

  /** 自愈加载：文件缺失/损坏则用空账本（不抛）。 */
  load(): QuotaLedgerData {
    if (this._loaded) return this._data;
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, "utf-8"));
        if (parsed && typeof parsed === "object" && typeof parsed.buckets === "object") {
          this._data = { version: STORAGE_VERSION, buckets: parsed.buckets || {} };
        }
      }
    } catch {
      this._data = { version: STORAGE_VERSION, buckets: {} };
    }
    this._loaded = true;
    return this._data;
  }

  private save(): void {
    atomicWriteSync(this.ledgerPath, JSON.stringify(this._data, null, 2) + "\n");
  }

  /** 设定兜底模型解析结果（由 failover D1 启动期注入；未启用则 null）。 */
  setFallbackModel(model: { id?: string; provider?: string } | null): void {
    this._fallbackModel = model ? normalizeModelRef(model) : null;
  }

  /** 当前模型是否为系统兜底模型（未启用 failover → 永远 false）。 */
  isFallbackModel(modelRef: any): boolean {
    if (!this._fallbackModel) return false;
    const ref = normalizeModelRef(modelRef);
    if (!ref) return false;
    const idMatch = this._fallbackModel.id === undefined || this._fallbackModel.id === ref.id;
    const providerMatch =
      this._fallbackModel.provider === undefined || this._fallbackModel.provider === ref.provider;
    return Boolean(idMatch && providerMatch);
  }

  /** 记录一次兜底模型消耗（cost 为 token 数）。 */
  recordFallbackUsage(userId: string, cost: number): void {
    if (!userId) return;
    this.load();
    const day = logicalDateKey(new Date(), quotaTimeZone());
    if (!this._data.buckets[day]) this._data.buckets[day] = {};
    this._data.buckets[day][userId] = (this._data.buckets[day][userId] || 0) + (Number(cost) || 0);
    this.save();
  }

  /** 取某 userId 在指定逻辑日的累计消耗。 */
  getUsage(userId: string, logicalDay?: string): number {
    if (!userId) return 0;
    this.load();
    const day = logicalDay ?? logicalDateKey(new Date(), quotaTimeZone());
    return this._data.buckets[day]?.[userId] || 0;
  }

  /** 某 userId 是否超出每日兜底配额（默认 0 = 无上限）。 */
  isOverQuota(userId: string): boolean {
    const quota = fallbackDailyQuota();
    if (quota <= 0) return false;
    return this.getUsage(userId) >= quota;
  }

  /**
   * 配额拦截判定（B2 边界）：对系统兜底模型按 userId 拦截。
   * 非兜底模型 / 未启用 failover / 无上限 → 一律放行。
   * @returns { ok: boolean, reason?: string }
   */
  checkLlmQuota(userId: string, modelRef: any): { ok: boolean; reason?: string } {
    if (this.isFallbackModel(modelRef) && this.isOverQuota(userId)) {
      return { ok: false, reason: "quota_exceeded" };
    }
    return { ok: true };
  }
}
