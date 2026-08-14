/**
 * M5 §2.2 — 密钥静止加密（at-rest encryption）基础原语。
 *
 * 为什么独立成模块：密钥静止加密的收口点唯一（见 plan B2/B3），所有 secret
 * 的加密/解密都经过这里，便于静态扫描与审计；不在别处散落 AES 调用。
 *
 * 设计要点：
 *  - 主密钥 `HANA_MASTER_KEY` 可为任意长度口令（如 `my-secret-pass`），内部经
 *    SHA-256 派生为固定 32 字节 AES-256 密钥，避免非 32 字节 key 直用抛错。
 *  - 密文自描述：`enc:v1:` 前缀 + AES-256-GCM（iv 12B / tag 16B / ct）。
 *  - 未设主密钥时 `getMasterKey()` 返回 null，调用方保持明文（向后兼容旧数据）。
 *
 * 与 secret-fs / secret-custody 的关系：secret-fs 负责文件权限（owner-only），
 * 本模块负责内容加密，二者正交、互补。
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/** 密文标记前缀（自描述版本号，便于未来轮换算法）。 */
export const ENC_PREFIX = "enc:v1:";

/** GCM 参数（AES-256-GCM 固定）。 */
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let _masterKeyCache: Buffer | null | undefined = undefined;

/**
 * 读取并派生主密钥。
 *
 * - 未设 `HANA_MASTER_KEY` → 返回 `null`（调用方应保持明文 + 告警，见 B4）。
 * - 设了则对原始输入做 SHA-256 标准化为 32 字节密钥（支持任意长度口令）。
 *
 * 结果进程内缓存（主密钥运行期不变）。
 */
export function getMasterKey(): Buffer | null {
  if (_masterKeyCache !== undefined) return _masterKeyCache;
  const raw = process.env.HANA_MASTER_KEY;
  if (!raw) {
    // 不设主密钥：不缓存（允许运行期稍后设置时重新读取），返回 null。
    return null;
  }
  // 任意长度 → 固定 32 字节。base64/hex/raw 统一经 SHA-256 派生，调用方无需关心形态。
  _masterKeyCache = createHash("sha256").update(raw, "utf-8").digest();
  return _masterKeyCache;
}

/** 测试/重载用：清空缓存（仅测试调用）。 */
export function _resetMasterKeyCacheForTest(): void {
  _masterKeyCache = undefined;
}

/**
 * 加密明文 secret。
 *
 * @returns `ENC_PREFIX + base64(iv | tag | ct)`；若主密钥未设则返回原值（明文兼容）。
 */
export function encryptSecret(plain: string): string {
  const key = getMasterKey();
  if (!key) return plain; // 未设主密钥：保持明文（向后兼容）
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * 解密 secret。
 *
 * - 识别 `ENC_PREFIX` 则解密；
 * - 否则（明文 / 旧数据 / 未设主密钥）原样返回（兼容）。
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getMasterKey();
  if (!key) return value; // 未设主密钥但遇到密文：无法解密，原样返回（由调用方告警）
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}

/** 是否已是本模块密文（自描述前缀）。 */
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
