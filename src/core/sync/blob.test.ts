import { describe, it, expect } from 'vitest';
import { generateDek } from './envelope';
import { blobIdFor, encryptBlob, decryptBlob, BLOB_MAGIC, BLOB_INLINE_LIMIT } from './blob';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 256);

describe('blob', () => {
  it('門檻是 256 KiB（spec 寫死，不得自行調整）', () => {
    expect(BLOB_INLINE_LIMIT).toBe(262144);
  });

  it('blobId 是內容定址：同內容同 id、不同內容不同 id', async () => {
    const a = await blobIdFor(bytes(1024));
    const b = await blobIdFor(bytes(1024));
    const c = await blobIdFor(bytes(1024, 2));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('加密後的 body 以 magic 開頭，且不含明文', async () => {
    const plain = new TextEncoder().encode('這是一張不該出現在雲端的圖片'.repeat(10));
    const id = await blobIdFor(plain);
    const { fileKey, body } = await encryptBlob(await generateDek(), id, plain);
    expect(new TextDecoder().decode(body.slice(0, 5))).toBe(BLOB_MAGIC);
    expect(new TextDecoder().decode(body)).not.toContain('不該出現在雲端');
    expect(fileKey).not.toMatch(/[+/=]/);
  });

  it('解密往返一致（含 0 位元組與 1 MiB）', async () => {
    const dek = await generateDek();
    for (const size of [0, 1, 262144, 1048576]) {
      const plain = bytes(size, 7);
      const id = await blobIdFor(plain);
      const { fileKey, body } = await encryptBlob(dek, id, plain);
      const back = await decryptBlob(dek, id, fileKey, body);
      expect(back.length).toBe(size);
      expect(Array.from(back.slice(0, 16))).toEqual(Array.from(plain.slice(0, 16)));
    }
  });

  it('blobId 不符、fileKey 不對、body 被動過都會失敗', async () => {
    const dek = await generateDek();
    const plain = bytes(2048);
    const id = await blobIdFor(plain);
    const { fileKey, body } = await encryptBlob(dek, id, plain);
    await expect(decryptBlob(dek, 'other-id', fileKey, body)).rejects.toThrow();
    await expect(decryptBlob(dek, id, fileKey, new Uint8Array([...body, 1]))).rejects.toThrow();
    const tampered = body.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBlob(dek, id, fileKey, tampered)).rejects.toThrow();
  });
});
