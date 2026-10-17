import { describe, it, expect } from 'vitest';
import { generateDek } from './envelope';
import { blobIdFor, encryptBlob, decryptBlob, BLOB_MAGIC, BLOB_INLINE_LIMIT } from './blob';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 256);

describe('blob 加密', () => {
  it('內聯門檻 180 KiB：要留足 JSON+加密+base64 的膨脹空間（否則會撞上服務端 256 KiB 行上限）', () => {
    expect(BLOB_INLINE_LIMIT).toBe(180 * 1024);
    expect(BLOB_INLINE_LIMIT).toBeLessThan(256 * 1024);
  });

  it('blobId 是內容定址：同內容同 id、不同內容不同 id', async () => {
    const a = await blobIdFor(bytes(1024));
    const b = await blobIdFor(bytes(1024));
    const c = await blobIdFor(bytes(1024, 2));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('v2：加密後的 body 以 magic 開頭、不含明文，且不再需要 fileKey（金鑰由 DEK+blobId 推導）', async () => {
    const plain = new TextEncoder().encode('這是一張不該出現在雲端的圖片'.repeat(10));
    const id = await blobIdFor(plain);
    const enc = await encryptBlob(await generateDek(), id, plain);
    expect(enc.fileKey).toBeUndefined();
    expect(new TextDecoder().decode(enc.body.slice(0, 5))).toBe(BLOB_MAGIC);
    expect(new TextDecoder().decode(enc.body)).not.toContain('不該出現在雲端');
  });

  it('v2：同一份內容 + 同一個 DEK，重複加密出來的密文都能用「推導鑰匙」解開（不再換鑰匙）', async () => {
    const dek = await generateDek();
    const plain = bytes(4096, 5);
    const id = await blobIdFor(plain);
    const first = await encryptBlob(dek, id, plain);
    const second = await encryptBlob(dek, id, plain);
    // 密文不同（隨機 IV），但兩份都能解 —— 這就是修好「重傳換鑰匙」的關鍵
    expect(Array.from(first.body)).not.toEqual(Array.from(second.body));
    expect(Array.from(await decryptBlob(dek, id, first.body))).toEqual(Array.from(plain));
    expect(Array.from(await decryptBlob(dek, id, second.body))).toEqual(Array.from(plain));
  });

  it('舊格式（隨機 fileKey）仍能解開，而且 v2 密文即使帶著舊 fileKey 也能靠 fallback 解開', async () => {
    const dek = await generateDek();
    const plain = bytes(2048, 3);
    const id = await blobIdFor(plain);

    const legacy = await encryptBlob(dek, id, plain, { legacy: true });
    expect(legacy.fileKey).toBeTruthy();
    expect(Array.from(await decryptBlob(dek, id, legacy.body, legacy.fileKey))).toEqual(Array.from(plain));
    // 沒有 fileKey → 舊格式解不開（兩個路徑都失敗）
    await expect(decryptBlob(dek, id, legacy.body)).rejects.toThrow();

    // v2 密文 + 一個壞掉的舊 fileKey：先試舊格式失敗，再 fallback v2 成功（過渡期資料不會被卡死）
    const v2 = await encryptBlob(dek, id, plain);
    const bogusFileKey = legacy.fileKey!;
    expect(Array.from(await decryptBlob(dek, id, v2.body, bogusFileKey))).toEqual(Array.from(plain));
  });

  it('解密往返一致（含 0 位元組與 1 MiB）', async () => {
    const dek = await generateDek();
    for (const size of [0, 1, 262144, 1048576]) {
      const plain = bytes(size, 7);
      const id = await blobIdFor(plain);
      const enc = await encryptBlob(dek, id, plain);
      const back = await decryptBlob(dek, id, enc.body);
      expect(back.length).toBe(size);
      expect(Array.from(back.slice(0, 16))).toEqual(Array.from(plain.slice(0, 16)));
    }
  });

  it('blobId 不符、金鑰不對（換 DEK）、body 被動過都會失敗', async () => {
    const dek = await generateDek();
    const plain = bytes(2048);
    const id = await blobIdFor(plain);
    const enc = await encryptBlob(dek, id, plain);
    await expect(decryptBlob(dek, 'other-id', enc.body)).rejects.toThrow();
    await expect(decryptBlob(await generateDek(), id, enc.body)).rejects.toThrow();
    const tampered = enc.body.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBlob(dek, id, tampered)).rejects.toThrow();
  });
});