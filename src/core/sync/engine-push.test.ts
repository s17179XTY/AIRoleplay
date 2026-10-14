/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { openDatabase, type DshDB } from '../storage/db';
import { installSyncTap, setApplyingRemote, pendingCount } from './outbox';
import { pushPending, getSyncState, getRev } from './engine';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek, decryptEnvelope } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);
const INVITE = 'INV-ENGINE';

/**
 * 一台「裝置」= 一個獨立的 IndexedDB。
 * 這裡刻意用 openDatabase 而不是 switchDatabase：後者會關掉前一個連線，
 * 而多裝置測試需要兩個庫同時活著。
 */
async function freshDevice(name: string): Promise<DshDB> {
  const d = openDatabase(name);
  await d.open();
  await installSyncTap(d);
  return d;
}

async function setupAccount() {
  const env = makeWorkerEnv();
  const server = makeFakeServer(env);
  await seedInvite(env, INVITE);

  const dek = await generateDek();
  const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
  const wrappedDek = await wrapDek(dek, master);
  const recoveryCode = generateRecoveryCode();

  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice',
    inviteCode: INVITE,
    authKey: await deriveAuthKey('pw-123', 'alice', TEST_KDF),
    kdf: JSON.stringify(TEST_KDF),
    wrappedDek,
    recoveryAuthKey: await deriveRecoveryAuthKey(recoveryCode, 'alice'),
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(recoveryCode, 'alice')),
    label: 'test',
  });
  return { env, server, client, dek, wrappedDek, master, recoveryCode };
}

describe('engine push', () => {
  it('本地未登入的資料也會進 outbox（不影響既有行為）', async () => {
    const db = await freshDevice(`push-a-${rnd()}`);
    await db.settings.put({ key: 'fontSize', value: '18' });
    expect(await pendingCount(db)).toBe(1);
  });

  it('pushPending 之後雲端只有密文、outbox 清空、rev 記在獨立表', async () => {
    const { env, client, dek } = await setupAccount();
    const db = await freshDevice(`push-b-${rnd()}`);
    await db.settings.put({ key: 'fontSize', value: '18' });

    const out = await pushPending({ db, client, dek, deviceId: 'dev_a' });
    expect(out).toEqual({ pushed: 1, conflicts: 0 });

    const stored = await env.DB.prepare("SELECT ciphertext, rev, size FROM records WHERE kind = 'setting'")
      .first<{ ciphertext: string; rev: number; size: number }>();
    expect(stored?.ciphertext).toBeTruthy();
    // 只驗長字串：base64url 密文可能碰巧含短字串（例如 "18"），那種斷言會隨機失敗
    expect(stored?.ciphertext).not.toContain('fontSize');
    expect(stored?.rev).toBe(1);

    // 而且真的解得回來，證明「雲端只有密文、本地有明文」
    const decoded = await decryptEnvelope<{ key: string; value: string }>(
      dek,
      'setting',
      'fontSize',
      stored!.ciphertext,
    );
    expect(decoded.data).toEqual({ key: 'fontSize', value: '18' });

    expect(await getRev(db, 'setting', 'fontSize')).toBe(1);
    expect(await pendingCount(db)).toBe(0);
  });

  it('刪除會送墓碑，雲端記錄消失', async () => {
    const { env, client, dek } = await setupAccount();
    const db = await freshDevice(`push-c-${rnd()}`);
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    await db.settings.put({ key: 'tmp', value: '1' });
    await pushPending(ctx);
    await db.settings.delete('tmp');
    await pushPending(ctx);

    const row = await env.DB.prepare("SELECT rev FROM records WHERE kind = 'setting' AND id = 'tmp'").first();
    expect(row).toBeNull();
    const last = await env.DB.prepare('SELECT deleted FROM changes ORDER BY seq DESC LIMIT 1').first<{ deleted: number }>();
    expect(last?.deleted).toBe(1);
  });

  it('provider 的秘密欄位永遠不會上傳', async () => {
    const { env, client, dek } = await setupAccount();
    const db = await freshDevice(`push-d-${rnd()}`);
    await db.providers.put({
      id: 'prov_1',
      label: '中轉',
      protocol: 'openai',
      baseUrl: 'https://api.example',
      apiKey: 'sk-LEAK-CANARY-1234567890',
      extraHeaders: { 'x-canary': 'HEADER-CANARY' },
      createdAt: 1,
    });

    await pushPending({ db, client, dek, deviceId: 'dev_a' });
    const rows = await env.DB.prepare("SELECT ciphertext FROM records WHERE kind = 'provider'").all<{ ciphertext: string }>();
    const dump = JSON.stringify(rows.results);
    expect(rows.results).toHaveLength(1);
    expect(dump).not.toContain('LEAK-CANARY');
    expect(dump).not.toContain('HEADER-CANARY');
  });

  it('同裝置連續兩次編輯：rev 遞增、不算衝突（rev 不會被整筆覆蓋抹掉）', async () => {
    const { env, client, dek } = await setupAccount();
    const db = await freshDevice(`push-e-${rnd()}`);
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    await db.settings.put({ key: 'k', value: 'v1' });
    expect(await pushPending(ctx)).toEqual({ pushed: 1, conflicts: 0 });
    // 注意這裡是整筆覆蓋寫入（App 的正常行為）：rev 存在獨立表才不會被抹掉
    await db.settings.put({ key: 'k', value: 'v2' });
    expect(await pushPending(ctx)).toEqual({ pushed: 1, conflicts: 0 });

    const row = await env.DB.prepare("SELECT rev FROM records WHERE kind = 'setting'").first<{ rev: number }>();
    expect(row?.rev).toBe(2);
    expect(await getRev(db, 'setting', 'k')).toBe(2);
    expect((await db.settings.get('k'))?.value).toBe('v2');
  });

  it('落後的 baseRev 會回報衝突，並把被覆蓋的版本留在 syncConflicts', async () => {
    const { client, dek } = await setupAccount();
    const dbA = await freshDevice(`push-f1-${rnd()}`);
    const dbB = await freshDevice(`push-f2-${rnd()}`);

    await dbA.settings.put({ key: 'k', value: 'v1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    // B 模擬「已經拉取過 rev 1」：內容與版本都對齊
    setApplyingRemote(true);
    await dbB.settings.put({ key: 'k', value: 'v1' });
    setApplyingRemote(false);
    await dbB.syncRev.put({ kind: 'setting', id: 'k', rev: 1 });

    // A 又改一次 → 雲端 rev 2
    await dbA.settings.put({ key: 'k', value: 'v2' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    // B 用過期的 baseRev=1 推送 → 衝突，被覆蓋的是 A 的 v2
    await dbB.settings.put({ key: 'k', value: 'v3' });
    const out = await pushPending({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(out.pushed).toBe(1);
    expect(out.conflicts).toBe(1);

    const stored = await dbB.syncConflicts.toArray();
    expect(stored).toHaveLength(1);
    const decoded = await decryptEnvelope<{ value: string }>(dek, stored[0].kind, stored[0].id, stored[0].ciphertext);
    expect(decoded.data.value).toBe('v2');

    // LWW：雲端最終是 B 的 v3、rev 3；B 本地版本也記到 3
    expect(await getRev(dbB, 'setting', 'k')).toBe(3);
    expect((await dbB.settings.get('k'))?.value).toBe('v3');
  });

  it('getSyncState 會記住 deviceId 與游標', async () => {
    const { client, dek } = await setupAccount();
    const db = await freshDevice(`push-g-${rnd()}`);
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    const state = await getSyncState(ctx);
    expect(state).toEqual({ cursor: 0, deviceId: 'dev_a' });
    expect((await db.syncState.get('deviceId'))?.value).toBe('dev_a');
  });
});
