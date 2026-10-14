/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../../src/types';

type Params = unknown[];

/** node:sqlite 只吃 string/number/bigint/null/Uint8Array；其他型別（布林、物件）在這裡收斂 */
function normalize(params: Params): (string | number | bigint | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
    if (p instanceof Uint8Array) return p;
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    return JSON.stringify(p);
  });
}

/**
 * 用 Node 24 內建的 node:sqlite 當 D1 的替身：測試跑的是「真的 SQL」，
 * 不是手寫的假資料層，所以 ON CONFLICT / RETURNING / AUTOINCREMENT / 交易回滾都驗得到。
 * 只有 workerd 特有的行為（CPU 上限、實際的 D1 網路層）要靠 Task 16 的 wrangler dev 冒煙。
 */
export function makeTestD1(seedSql?: string): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  if (seedSql) raw.exec(seedSql);

  function statement(query: string, params: Params = []): D1PreparedStatement {
    return {
      bind(...values: unknown[]) {
        return statement(query, values);
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const row = raw.prepare(query).get(...normalize(params)) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] ?? null) as T | null;
        return row as T;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const rows = raw.prepare(query).all(...normalize(params)) as T[];
        return { results: rows, success: true, meta: { rows_read: rows.length } };
      },
      async run(): Promise<D1Result> {
        const info = raw.prepare(query).run(...normalize(params));
        return {
          results: [],
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
  }

  return {
    raw,
    prepare: (query: string) => statement(query),
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      raw.exec('BEGIN');
      try {
        const out: D1Result[] = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(query: string) {
      raw.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}
