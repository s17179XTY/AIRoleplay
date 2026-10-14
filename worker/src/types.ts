export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

/**
 * Workers KV 的最小介面（只列我們真的用到的方法）。
 * 不用 R2：R2 免費額度雖有 10 GB，但**啟用必須綁付款方式**（code 10042）；
 * KV 含在 Workers 免費方案內（1 GB / 帳號、單值 25 MiB、寫入 1000 次 / 日）。
 */
export interface KVNamespace {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: { metadata?: unknown }): Promise<void>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  DB: D1Database;
  BLOBS: KVNamespace;
  ALLOWED_ORIGINS: string;
  ADMIN_SECRET: string;
}
