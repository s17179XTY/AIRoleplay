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

afterEach(() => {
  cleanup();
});
