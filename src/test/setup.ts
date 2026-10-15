/// <reference types="node" />
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom 的 crypto 只有 getRandomValues，沒有 subtle；PBKDF2 / AES-GCM 全靠它。
// 只補 subtle、不整顆換掉 crypto，是為了保住 randomUUID（db.ts 的 newId() 仰賴）。
const jsdomCrypto = globalThis.crypto as Crypto | undefined;
if (jsdomCrypto && !jsdomCrypto.subtle) {
  Object.defineProperty(jsdomCrypto, 'subtle', { value: webcrypto.subtle, configurable: true });
}

// jsdom 也沒實作 URL.createObjectURL / revokeObjectURL（图片预览要用）。
// 补一个假的：只回一个可辨识的字串，测试里不会真的去读它。
if (typeof URL.createObjectURL !== 'function') {
  let seq = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => `blob:jsdom/${++seq}`,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: () => undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
});
