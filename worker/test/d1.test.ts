/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { makeTestD1 } from './helpers/d1';
import { MIGRATION_SQL } from './helpers/migration';

const migration = MIGRATION_SQL;

describe('測試用 D1 替身', () => {
  it('吃得下完整的 0001 migration', () => {
    const db = makeTestD1(migration);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ['users', 'invites', 'sessions', 'records', 'changes', 'blobs', 'rate', 'resets']) {
      expect(names).toContain(t);
    }
  });

  it('bind / first / all / run 行為與 D1 一致', async () => {
    const db = makeTestD1(migration);
    await db
      .prepare(
        'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind('u1', 'alice', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', 1)
      .run();

    const one = await db.prepare('SELECT username FROM users WHERE id = ?').bind('u1').first<{ username: string }>();
    expect(one?.username).toBe('alice');

    const all = await db.prepare('SELECT id FROM users').all<{ id: string }>();
    expect(all.results.map((r) => r.id)).toEqual(['u1']);

    const missing = await db.prepare('SELECT id FROM users WHERE id = ?').bind('nope').first();
    expect(missing).toBeNull();
  });

  it('AUTOINCREMENT 的 seq 單調遞增', async () => {
    const db = makeTestD1(migration);
    await db.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,?,?)').bind('u1', 'chat', 'c1', 0, 1).run();
    await db.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,?,?)').bind('u1', 'chat', 'c2', 0, 2).run();
    const rows = await db.prepare('SELECT seq FROM changes ORDER BY seq').all<{ seq: number }>();
    expect(rows.results.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('batch 內的多個 statement 一起生效', async () => {
    const db = makeTestD1(migration);
    const results = await db.batch([
      db.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)').bind('h1', 'a', 1, null),
      db.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)').bind('h2', 'b', 2, null),
    ]);
    expect(results).toHaveLength(2);
    const rows = await db.prepare('SELECT code_hash FROM invites ORDER BY code_hash').all<{ code_hash: string }>();
    expect(rows.results.map((r) => r.code_hash)).toEqual(['h1', 'h2']);
  });

  it('batch 中有一條壞 SQL 時整批回滾（不留半套資料）', async () => {
    const db = makeTestD1(migration);
    await expect(
      db.batch([
        db.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)').bind('h1', 'a', 1, null),
        db.prepare('INSERT INTO nonexistent_table (x) VALUES (1)'),
      ]),
    ).rejects.toThrow();
    const rows = await db.prepare('SELECT code_hash FROM invites').all<{ code_hash: string }>();
    expect(rows.results).toEqual([]);
  });
});
