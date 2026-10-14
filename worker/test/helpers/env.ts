/// <reference types="node" />
import { makeTestD1 } from './d1';
import type { Env, R2Bucket } from '../../src/types';

export function makeTestR2(): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      store.set(key, value.slice());
      return { key };
    },
    async get(key) {
      const found = store.get(key);
      if (!found) return null;
      return { size: found.length, arrayBuffer: async () => found.slice().buffer };
    },
    async head(key) {
      const found = store.get(key);
      return found ? { size: found.length } : null;
    },
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  };
}

export function makeTestEnv(seedSql: string, over: Partial<Env> = {}): Env {
  return {
    DB: makeTestD1(seedSql),
    BLOBS: makeTestR2(),
    ALLOWED_ORIGINS: 'https://air-roleplay.pages.dev',
    ADMIN_SECRET: 'test-secret',
    ...over,
  };
}
