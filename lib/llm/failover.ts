/**
 * M5 §2.4 — 兜底模型 Failover（显式配 + 严格 LLM retryable 三码）。
 *
 * 关键边界（spec grilling Q1/Q4）：
 *  - 触发严格限定 LLM 类且 retryable:true 的三码（LLM_TIMEOUT / LLM_RATE_LIMITED /
 *    LLM_EMPTY_RESPONSE）；LLM_AUTH_FAILED / LLM_SLOW_RESPONSE 为 retryable:false，不触发。
 *  - 启动期 fail-closed：HANA_FALLBACK_MODEL 解析失败 → 仅禁用 failover（不 crash server）。
 *  - 运行期缓存 fallbackModelResolved，供 quota-ledger.isFallbackModel 复用（限流对象与
 *    failover 目标一致）。配额检查器在 initFallback 内统一注册（全局单实例前提）。
 */
import { QuotaLedger } from "./quota-ledger.ts";

/** 严格 LLM retryable 三码（与 shared/errors.ts 对齐，不泛化全集）。 */
export const RETRYABLE_FALLBACK_CODES = new Set([
  "LLM_TIMEOUT",
  "LLM_RATE_LIMITED",
  "LLM_EMPTY_RESPONSE",
]);

/** 是否应触发 failover：错误码属严格三码。 */
export function shouldFailover(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? (typeof err === "object" ? err.error : null);
  return RETRYABLE_FALLBACK_CODES.has(code);
}

/** 从环境变量解析兜底模型引用（"provider/id" 或 "{id,provider}"）。 */
export function resolveFallbackModelRef(): { id: string; provider: string } | null {
  const raw = process.env.HANA_FALLBACK_MODEL;
  if (!raw || !raw.trim()) return null;
  if (raw.includes("/")) {
    const [provider, id] = raw.split("/");
    if (provider && id) return { provider, id };
  }
  return { provider: "custom", id: raw.trim() };
}

// ── 运行期状态（进程级单例） ─────────────────────────────────────────
let _fallbackEnabled = false;
let _fallbackModelResolved: { id?: string; provider?: string } | null = null;
let _quotaLedger: QuotaLedger | null = null;

export function isFallbackEnabled(): boolean {
  return _fallbackEnabled;
}

export function getFallbackModel(): { id?: string; provider?: string } | null {
  return _fallbackModelResolved;
}

export function getQuotaLedger(): QuotaLedger | null {
  return _quotaLedger;
}

/**
 * D1 启动期 fail-closed 校验 + 配额接线。
 * 在 engine.init() 之后调用（_availableModels 已就绪）。
 *
 * @param engine HanaEngine 实例（暴露 resolveExecutionModel / resolveModelWithCredentialsFresh）
 * @param hanakoHome 用于 QuotaLedger 持久化路径
 * @returns { fallbackEnabled, fallbackModel }
 */
export function initFallback(engine: any, hanakoHome: string): {
  fallbackEnabled: boolean;
  fallbackModel: { id?: string; provider?: string } | null;
} {
  const ref = resolveFallbackModelRef();
  if (!ref) {
    _fallbackEnabled = false;
    _fallbackModelResolved = null;
    return { fallbackEnabled: false, fallbackModel: null };
  }
  // 解析失败：仅禁用 failover，不 crash（resolveExecutionModel 抛普通 Error，非 AppError）。
  let resolved: any = null;
  try {
    resolved = engine.resolveExecutionModel(ref);
  } catch (err: any) {
    _fallbackEnabled = false;
    _fallbackModelResolved = null;
    // eslint-disable-next-line no-console
    console.error(
      `[failover] HANA_FALLBACK_MODEL "${process.env.HANA_FALLBACK_MODEL}" 解析失败，` +
        `已禁用 failover（不会 crash）：${err?.message || err}`,
    );
    return { fallbackEnabled: false, fallbackModel: null };
  }
  _fallbackModelResolved = { id: resolved?.id, provider: resolved?.provider };
  _fallbackEnabled = true;

  // 配额账本接线（全局单实例）：setFallbackModel 复用同一解析结果，setQuotaChecker 供
  // callText 入口与 chat onMessage 预检共用。
  _quotaLedger = new QuotaLedger(hanakoHome);
  _quotaLedger.setFallbackModel(_fallbackModelResolved);
  // setQuotaChecker 位于 core/llm-client.ts，避免在此循环 import；由调用方（server/index.ts）
  // 在 import llm-client 后注册。此处仅准备 ledger。
  return { fallbackEnabled: true, fallbackModel: _fallbackModelResolved };
}
