import { describe, it, expect } from 'vitest';
import { deriveMasterKey, TEST_KDF } from './kdf';
import {
  generateDek, exportDekRaw, importDekRaw, wrapDek, unwrapDek,
  encryptEnvelope, decryptEnvelope, dekFingerprint, type Envelope,
} from './envelope';

const env = (data: unknown): Envelope => ({ v: 1, rev: 3, updatedAt: 1760412345678, deviceId: 'dev_a', data });

describe('envelope', () => {
  it('產生 DEK → 匯出 → 匯入後指紋一致', async () => {
    const dek = await generateDek();
    const again = await importDekRaw(await exportDekRaw(dek));
    expect(await dekFingerprint(again)).toBe(await dekFingerprint(dek));
    expect(await dekFingerprint(dek)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('用 masterKey 包 DEK 再解回來，能解同一封信', async () => {
    const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, master);
    const unwrapped = await unwrapDek(wrapped, master);
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ title: '秘密標題' }));
    const back = await decryptEnvelope<{ title: string }>(unwrapped, 'chat', 'chat_1', ct);
    expect(back.data.title).toBe('秘密標題');
    expect(back.rev).toBe(3);
  });

  it('信封內容不含明文（連標題都看不到）', async () => {
    const dek = await generateDek();
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ title: '不可以出現在這裡' }));
    expect(ct).not.toContain('不可以出現在這裡');
    expect(ct).not.toMatch(/[+/=]/);
  });

  it('AAD 綁定 kind 與 id：把密文搬到別的 id 會解不開', async () => {
    const dek = await generateDek();
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ a: 1 }));
    await expect(decryptEnvelope(dek, 'chat', 'chat_2', ct)).rejects.toThrow();
    await expect(decryptEnvelope(dek, 'message', 'chat_1', ct)).rejects.toThrow();
  });

  it('錯的 DEK 解不開（不是回傳垃圾）', async () => {
    const ct = await encryptEnvelope(await generateDek(), 'chat', 'chat_1', env({ a: 1 }));
    await expect(decryptEnvelope(await generateDek(), 'chat', 'chat_1', ct)).rejects.toThrow();
  });

  it('錯的 masterKey 解不開 wrappedDek', async () => {
    const right = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    const wrong = await deriveMasterKey('pw-124', 'alice', TEST_KDF);
    const wrapped = await wrapDek(await generateDek(), right);
    await expect(unwrapDek(wrapped, wrong)).rejects.toThrow();
  });
});
