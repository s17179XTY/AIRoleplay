/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = join(process.cwd(), 'worker', 'migrations');

/**
 * 讀出**全部** D1 migration 的 SQL（依檔名排序，與 `wrangler d1 migrations apply` 的順序一致）。
 *
 * 用 process.cwd() 而不是 import.meta.url：vitest 跑在 jsdom 環境時，模組 URL 不是 file: scheme，
 * `new URL('../migrations/...', import.meta.url)` 會直接噴「The URL must be of scheme file」。
 * vitest 的工作目錄一律是專案根目錄，所以這裡用 cwd 最穩。
 */
export const MIGRATION_SQL = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n');
