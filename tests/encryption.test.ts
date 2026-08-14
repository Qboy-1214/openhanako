import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
  isEncrypted,
  _resetMasterKeyCacheForTest,
} from "../shared/encryption.ts";

describe("shared/encryption", () => {
  const ORIGINAL = process.env.HANA_MASTER_KEY;

  beforeEach(() => {
    _resetMasterKeyCacheForTest();
    delete process.env.HANA_MASTER_KEY;
  });

  afterEach(() => {
    _resetMasterKeyCacheForTest();
    if (ORIGINAL === undefined) delete process.env.HANA_MASTER_KEY;
    else process.env.HANA_MASTER_KEY = ORIGINAL;
  });

  it("getMasterKey returns null when HANA_MASTER_KEY unset", () => {
    expect(getMasterKey()).toBeNull();
  });

  it("getMasterKey derives a stable 32-byte key from an arbitrary-length passphrase", () => {
    process.env.HANA_MASTER_KEY = "my-secret-pass";
    const k1 = getMasterKey();
    expect(k1).toHaveLength(32);
    // 缓存命中返回同一实例
    expect(getMasterKey()).toBe(k1);
  });

  it("encryptSecret/decryptSecret round-trip restores the plaintext", () => {
    process.env.HANA_MASTER_KEY = "my-secret-pass";
    const plain = "sk-1234567890abcdef";
    const cipher = encryptSecret(plain);
    expect(cipher).not.toBe(plain);
    expect(isEncrypted(cipher)).toBe(true);
    expect(decryptSecret(cipher)).toBe(plain);
  });

  it("encryptSecret with a short passphrase (non-32-byte) does not throw (SHA-256 derivation)", () => {
    process.env.HANA_MASTER_KEY = "x"; // 1 字节，非 32 字节
    expect(() => encryptSecret("secret")).not.toThrow();
    expect(decryptSecret(encryptSecret("secret"))).toBe("secret");
  });

  it("decryptSecret leaves plaintext untouched (backward compatible)", () => {
    process.env.HANA_MASTER_KEY = "key";
    expect(decryptSecret("plaintext-value")).toBe("plaintext-value");
    expect(isEncrypted("plaintext-value")).toBe(false);
  });

  it("encryptSecret returns plaintext when master key unset (compat mode)", () => {
    const plain = "sk-unset";
    expect(encryptSecret(plain)).toBe(plain);
  });

  it("decryptSecret cannot recover under a different master key", () => {
    process.env.HANA_MASTER_KEY = "key-a";
    const cipher = encryptSecret("topsecret");
    _resetMasterKeyCacheForTest();
    process.env.HANA_MASTER_KEY = "key-b";
    // 不同密钥解密 GCM 校验失败 → 抛错（不静默返回错误内容）
    expect(() => decryptSecret(cipher)).toThrow();
  });
});
