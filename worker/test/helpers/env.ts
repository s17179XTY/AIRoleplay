/// <reference types="node" />
import { makeTestD1 } from './d1';
import { makeTestKV } from './kv';
import type { Env } from '../../src/types';

export function makeTestEnv(seedSql: string, over: Partial<Env> = {}): Env {
  return {
    DB: makeTestD1(seedSql),
    BLOBS: makeTestKV(),
    ALLOWED_ORIGINS: 'https://air-roleplay.pages.dev',
    ADMIN_SECRET: 'test-secret',
    ...over,
  };
}
