/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv } from './helpers/env';
import { testKV } from './helpers/kv';
import { MIGRATION_SQL } from './helpers/migration';
import { handlePutBlob, handleGetBlob, blobKey, MAX_BLOB_BYTES, releaseBlobsForRecord } from '../src/blob';
import type { Env } from '../src/types';

const USER = 'u_1';

const bytes = (n: number, seed = 3) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 256);

async function seedUser(env: Env, quota = 1073741824) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
  )
    .bind(USER, 'alice', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', quota, 1)
    .run();
}

describe('blob 端點（KV）', () => {
  let env: Env;
  beforeEach(async () => {
    env = makeTestEnv(MIGRATION_SQL);
    await seedUser(env);
  });

  it('KV key 一定帶 userId 前綴（不做跨帳號去重）', () => {
    expect(blobKey('u_1', 'abc')).toBe('u_1/abc');
    expect(blobKey('u_2', 'abc')).toBe('u_2/abc');
  });

  it('上傳後可以原樣取回，並記進 blobs 表與配額', async () => {
    const body = bytes(1024);
    const put = await handlePutBlob(env, USER, 'blob_a', body.buffer, 1000);
    expect(put.status).toBe(200);

    const got = await handleGetBlob(env, USER, 'blob_a');
    expect(got.status).toBe(200);
    expect(new Uint8Array(got.bytes!).length).toBe(1024);
    expect(Array.from(new Uint8Array(got.bytes!).slice(0, 4))).toEqual([0, 3, 6, 9]);

    const row = await env.DB.prepare('SELECT blob_id, user_id, size, ref_count FROM blobs WHERE blob_id = ?')
      .bind('blob_a')
      .first<{ blob_id: string; user_id: string; size: number; ref_count: number }>();
    expect(row?.user_id).toBe(USER);
    expect(row?.size).toBe(1024);
    expect(row?.ref_count).toBe(1);

    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(1024);
  });

  it('別的帳號取不到（key 前綴隔離）', async () => {
    await handlePutBlob(env, USER, 'blob_a', bytes(64).buffer, 1000);
    await env.DB.prepare(
      'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
    )
      .bind('u_2', 'bob', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', 1073741824, 1)
      .run();
    expect((await handleGetBlob(env, 'u_2', 'blob_a')).status).toBe(404);
  });

  it('重複上傳同一個 blob 不會重複扣配額、ref_count 不變', async () => {
    await handlePutBlob(env, USER, 'blob_a', bytes(100).buffer, 1000);
    await handlePutBlob(env, USER, 'blob_a', bytes(100).buffer, 1001);
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(100);
    const row = await env.DB.prepare('SELECT ref_count FROM blobs WHERE blob_id = ?').bind('blob_a').first<{ ref_count: number }>();
    expect(row?.ref_count).toBe(1);
  });

  it('超過 8 MiB 被拒（413）', async () => {
    const res = await handlePutBlob(env, USER, 'blob_big', new ArrayBuffer(MAX_BLOB_BYTES + 1), 1000);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('blob_too_large');
  });

  it('空 blob 被拒（400）', async () => {
    const res = await handlePutBlob(env, USER, 'blob_empty', new ArrayBuffer(0), 1000);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('blob_empty');
  });

  it('配額不足被拒（413），且不會留下半套資料', async () => {
    const small = makeTestEnv(MIGRATION_SQL);
    await seedUser(small, 100);
    const res = await handlePutBlob(small, USER, 'blob_big', bytes(200).buffer, 1000);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('quota_exceeded');
    expect(await small.DB.prepare('SELECT blob_id FROM blobs').first()).toBeNull();
    expect((await handleGetBlob(small, USER, 'blob_big')).status).toBe(404);
  });

  it('取不到時回 404（不是 500）——最終一致性要靠客戶端重試', async () => {
    const res = await handleGetBlob(env, USER, 'nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('blob_missing');
  });

  it('KV 還沒傳播（暫時讀不到）時也是 404，等一下就取得到', async () => {
    await handlePutBlob(env, USER, 'blob_c', bytes(50).buffer, 1000);
    testKV(env).setVisible(blobKey(USER, 'blob_c'), false);
    expect((await handleGetBlob(env, USER, 'blob_c')).status).toBe(404);
    testKV(env).setVisible(blobKey(USER, 'blob_c'), true);
    expect((await handleGetBlob(env, USER, 'blob_c')).status).toBe(200);
  });

  it('回收：ref_count 歸零就刪 KV 並扣回配額', async () => {
    await handlePutBlob(env, USER, 'blob_a', bytes(100).buffer, 1000);
    expect(testKV(env).keys()).toContain(blobKey(USER, 'blob_a'));

    await releaseBlobsForRecord(env, USER, 'blob_a', 100);

    expect((await handleGetBlob(env, USER, 'blob_a')).status).toBe(404);
    expect(testKV(env).keys()).not.toContain(blobKey(USER, 'blob_a'));
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(0);
    expect(await env.DB.prepare('SELECT blob_id FROM blobs').first()).toBeNull();
  });

  it('回收不存在的 blob 不會炸', async () => {
    await releaseBlobsForRecord(env, USER, 'never_existed', 10);
    await releaseBlobsForRecord(env, USER, null, 10);
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(0);
  });
});
