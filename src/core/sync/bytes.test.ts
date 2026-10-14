import { describe, it, expect } from 'vitest';
import { utf8, fromUtf8, toBase64Url, fromBase64Url, toHex, concatBytes } from './bytes';

describe('bytes', () => {
  it('utf8 與 fromUtf8 往返（含中文）', () => {
    expect(fromUtf8(utf8('角色扮演 ok'))).toBe('角色扮演 ok');
  });

  it('base64url 往返且不含 + / =', () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const enc = toBase64Url(src);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(enc))).toEqual(Array.from(src));
  });

  it('base64url 需要補 padding 的長度也能解回來', () => {
    for (const n of [1, 2, 3, 4, 5, 17]) {
      const src = new Uint8Array(n).fill(7);
      expect(Array.from(fromBase64Url(toBase64Url(src)))).toEqual(Array.from(src));
    }
  });

  it('toHex 補零到兩位', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('concatBytes 依序串接', () => {
    expect(Array.from(concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3])))).toEqual([1, 2, 3]);
  });

  it('測試環境有 crypto.subtle（PBKDF2 需要）', () => {
    expect(typeof globalThis.crypto.subtle).toBe('object');
  });
});
