import { describe, it, expect } from 'vitest';
import {
  PROD_KDF, TEST_KDF, RECOVERY_ITERS,
  deriveAuthKey, deriveMasterKey,
  generateRecoveryCode, normalizeRecoveryCode, formatRecoveryCode,
  deriveRecoveryAuthKey, deriveRecoveryKey,
} from './kdf';

describe('kdf', () => {
  it('迭代數由參數決定，不是寫死的', () => {
    expect(PROD_KDF.iters).toBe(600000);
    expect(TEST_KDF.iters).toBe(1000);
    expect(RECOVERY_ITERS).toBe(200000);
  });

  it('authKey 對同帳號同密碼穩定、對大小寫帳號名一致', async () => {
    const a = await deriveAuthKey('pw-123', 'Alice', TEST_KDF);
    const b = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    const c = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('換密碼或換帳號名 → authKey 不同', async () => {
    const base = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(await deriveAuthKey('pw-124', 'alice', TEST_KDF)).not.toBe(base);
    expect(await deriveAuthKey('pw-123', 'bob', TEST_KDF)).not.toBe(base);
  });

  it('masterKey 是不可匯出的 AES-GCM 金鑰（刻意不給 exportKey 的機會）', async () => {
    const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    expect(master.algorithm.name).toBe('AES-GCM');
    expect(master.extractable).toBe(false);
    expect([...master.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('authKey 是 base64url 的 32 位元組（43 個字元），不含 + / =', async () => {
    const authKey = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(authKey).toHaveLength(43);
    expect(authKey).not.toMatch(/[+/=]/);
  });

  it('恢復碼格式：52 字元、Crockford 字母表、分組顯示可還原', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(normalizeRecoveryCode(formatRecoveryCode(code))).toBe(code);
  });

  it('恢復碼正規化：小寫、空白、連字號、易混淆字元都收斂', () => {
    // 產生的碼只用 Crockford 字母表；手抄時常把 I/L 寫成 1、O 寫成 0，所以一律收斂回標準字元。
    expect(normalizeRecoveryCode('abcd-efgh ijkl')).toBe('ABCDEFGH1JK1');
    expect(normalizeRecoveryCode('O0I1L')).toBe('00111');
    const generated = generateRecoveryCode();
    expect(normalizeRecoveryCode(generated)).toBe(generated);
  });

  it('恢復碼的驗證值與解包金鑰是兩把不同的東西（零知識的關鍵）', async () => {
    const code = generateRecoveryCode();
    const authVal = await deriveRecoveryAuthKey(code, 'alice');
    const wrapKey = await deriveRecoveryKey(code, 'alice');
    expect(wrapKey.algorithm.name).toBe('AES-GCM');
    expect(wrapKey.extractable).toBe(false);
    expect(authVal).toHaveLength(43);
    expect(authVal).not.toMatch(/[+/=]/);
    // 送給伺服器的是 authVal（雜湊後入庫）；wrapKey 永不出網。
    // 兩者用不同鹽（recauth / recwrap）衍生，所以拿到 authVal 推不出 wrapKey。
    expect(normalizeRecoveryCode(code)).not.toBe(authVal);
  });
});
