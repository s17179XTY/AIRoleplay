/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { MIGRATION_SQL } from './helpers/migration';
import { handlePull, handlePush, MAX_PUSH_BATCH, MAX_ROW_BYTES } from '../src/sync';
import type { Env } from '../src/types';

const USER = 'u_1';

const rec = (over: Record<string, unknown> = {}) => ({
  kind: 'chat', id: 'chat_1', rev: 1, baseRev: 0, updatedAt: 1000,
  size: 10, ciphertext: 'CT-1', ...over,
});

async function seedUser(env: Env, id = USER, username = 'alice', quota = 1000) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
  )
    .bind(id, username, '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', quota, 1)
    .run();
}

describe('sync push/pull', () => {
  let env: Env;
  beforeEach(async () => {
    env = makeTestEnv(MIGRATION_SQL);
    await seedUser(env);
  });

  it('新記錄直接入庫，並在 changes 追加一筆', async () => {
    const res = await handlePush(env, USER, { records: [rec()] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([{ kind: 'chat', id: 'chat_1', rev: 1 }]);
    const change = await env.DB.prepare('SELECT seq, deleted FROM changes WHERE user_id = ?')
      .bind(USER)
      .first<{ seq: number; deleted: number }>();
    expect(change?.seq).toBe(1);
    expect(change?.deleted).toBe(0);
  });

  it('baseRev 相符 → 快進到 baseRev+1', async () => {
    await handlePush(env, USER, { records: [rec()] });
    const res = await handlePush(env, USER, { records: [rec({ rev: 1, baseRev: 1, ciphertext: 'CT-2' })] });
    expect(res.body.accepted).toEqual([{ kind: 'chat', id: 'chat_1', rev: 2 }]);
    expect(res.body.conflicts).toEqual([]);
  });

  it('baseRev 落後 → LWW 接受但回報衝突，並帶回被覆蓋的密文（≤64 KiB）', async () => {
    await handlePush(env, USER, { records: [rec()] });
    await handlePush(env, USER, { records: [rec({ rev: 1, baseRev: 1, ciphertext: 'CT-2' })] });
    const res = await handlePush(env, USER, { records: [rec({ rev: 1, baseRev: 1, ciphertext: 'CT-3' })] });
    expect(res.body.accepted).toEqual([{ kind: 'chat', id: 'chat_1', rev: 3 }]);
    expect(res.body.conflicts).toEqual([{ kind: 'chat', id: 'chat_1', serverRev: 2, serverCiphertext: 'CT-2' }]);
  });

  it('墓碑：刪除會移除記錄並追加 deleted=1 的變更', async () => {
    await handlePush(env, USER, { records: [rec()] });
    await handlePush(env, USER, { records: [{ kind: 'chat', id: 'chat_1', rev: 0, baseRev: 0, updatedAt: 2000, deleted: true }] });
    const row = await env.DB.prepare('SELECT rev FROM records WHERE user_id = ? AND kind = ? AND id = ?')
      .bind(USER, 'chat', 'chat_1')
      .first();
    expect(row).toBeNull();
    const last = await env.DB.prepare('SELECT deleted FROM changes WHERE user_id = ? ORDER BY seq DESC LIMIT 1')
      .bind(USER)
      .first<{ deleted: number }>();
    expect(last?.deleted).toBe(1);
  });

  it('pull 依 seq 游標增量回傳，刪除項不帶密文', async () => {
    await handlePush(env, USER, { records: [rec()] });
    await handlePush(env, USER, { records: [rec({ id: 'chat_2', ciphertext: 'CT-2' })] });
    const first = await handlePull(env, USER, 0);
    expect(first.body.records as unknown[]).toHaveLength(2);
    expect(first.body.cursor).toBe(2);

    await handlePush(env, USER, { records: [{ kind: 'chat', id: 'chat_1', rev: 0, baseRev: 0, updatedAt: 3000, deleted: true }] });
    const inc = await handlePull(env, USER, 2);
    const rows = inc.body.records as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted).toBe(true);
    expect(rows[0].ciphertext).toBeUndefined();
  });

  it('pull 支援 hasMore 與 limit', async () => {
    for (let i = 0; i < 5; i++) await handlePush(env, USER, { records: [rec({ id: `chat_${i}` })] });
    const page = await handlePull(env, USER, 0, 2);
    expect(page.body.records as unknown[]).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);
    expect(page.body.cursor).toBe(2);
  });

  it('別的帳號的資料不會出現在我的 pull 裡', async () => {
    await seedUser(env, 'u_2', 'bob');
    await handlePush(env, 'u_2', { records: [rec({ id: 'bob_chat' })] });
    const mine = await handlePull(env, USER, 0);
    expect(mine.body.records).toEqual([]);
  });

  it('超過單筆 256 KiB 被拒（413）', async () => {
    const res = await handlePush(env, USER, { records: [rec({ size: MAX_ROW_BYTES + 1 })] });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('row_too_large');
  });

  it('超過每批 20 筆被拒（400）', async () => {
    const many = Array.from({ length: MAX_PUSH_BATCH + 1 }, (_, i) => rec({ id: `chat_${i}` }));
    const res = await handlePush(env, USER, { records: many });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('batch_too_large');
  });

  it('配額用盡回 413 且帶用量', async () => {
    const res = await handlePush(env, USER, { records: [rec({ size: 5000 })] });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('quota_exceeded');
    expect((res.body.quota as { limit: number }).limit).toBe(1000);
  });

  it('blobRef 會記進 records', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_x', size: 5 })] });
    const row = await env.DB.prepare('SELECT blob_ref FROM records WHERE id = ?').bind('a1').first<{ blob_ref: string }>();
    expect(row?.blob_ref).toBe('blob_x');
  });

  it('刪掉帶 blobRef 的記錄時，blob 引用數歸零、KV 與配額一併回收', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_x', size: 5 })] });
    await env.DB.prepare("INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES ('blob_x', ?, 1024, 1, 1)")
      .bind(USER)
      .run();
    await env.DB.prepare('UPDATE users SET used_bytes = 1024 WHERE id = ?').bind(USER).run();
    await env.BLOBS.put(`${USER}/blob_x`, new Uint8Array([1, 2, 3]));

    await handlePush(env, USER, {
      records: [{ kind: 'assetMeta', id: 'a1', rev: 0, baseRev: 0, updatedAt: 2000, deleted: true }],
    });

    expect(await env.DB.prepare("SELECT blob_id FROM blobs WHERE blob_id = 'blob_x'").first()).toBeNull();
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(0);
    expect(await env.BLOBS.get(`${USER}/blob_x`, 'arrayBuffer')).toBeNull();
  });

  it('改寫同一筆但 blobRef 換了：舊的回收、新的保留', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_old', size: 5 })] });
    for (const id of ['blob_old', 'blob_new']) {
      await env.DB.prepare('INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES (?,?,?,?,1)')
        .bind(id, USER, 100, 1)
        .run();
      await env.BLOBS.put(`${USER}/${id}`, new Uint8Array([7]));
    }

    await handlePush(env, USER, {
      records: [rec({ kind: 'assetMeta', id: 'a1', baseRev: 1, rev: 2, blobRef: 'blob_new', size: 7 })],
    });

    expect(await env.DB.prepare("SELECT blob_id FROM blobs WHERE blob_id = 'blob_old'").first()).toBeNull();
    const kept = await env.DB.prepare("SELECT ref_count FROM blobs WHERE blob_id = 'blob_new'").first<{ ref_count: number }>();
    expect(kept?.ref_count).toBe(1);
  });

  it('blobRef 沒變時不會誤刪 blob', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_x', size: 5 })] });
    await env.DB.prepare("INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES ('blob_x', ?, 100, 1, 1)")
      .bind(USER)
      .run();

    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', baseRev: 1, rev: 2, blobRef: 'blob_x', size: 5 })] });

    const kept = await env.DB.prepare("SELECT ref_count FROM blobs WHERE blob_id = 'blob_x'").first<{ ref_count: number }>();
    expect(kept?.ref_count).toBe(1);
  });
});
