/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { openDatabase, type DshDB } from '../storage/db';
import { installSyncTap, pendingCount } from './outbox';
import { pushPending, pullChanges, syncNow, initialPush, getSyncState } from './engine';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);
const INVITE = 'INV-PULL';

/** 多裝置測試需要兩個庫同時活著，所以用 openDatabase（switchDatabase 會關掉前一個） */
async function device(name: string): Promise<DshDB> {
  const d = openDatabase(name);
  await d.open();
  await installSyncTap(d);
  return d;
}

async function account() {
  const env = makeWorkerEnv();
  const server = makeFakeServer(env);
  await seedInvite(env, INVITE);

  const dek = await generateDek();
  const master = await deriveMasterKey('pw', 'alice', TEST_KDF);
  const recovery = generateRecoveryCode();
  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice',
    inviteCode: INVITE,
    authKey: await deriveAuthKey('pw', 'alice', TEST_KDF),
    kdf: JSON.stringify(TEST_KDF),
    wrappedDek: await wrapDek(dek, master),
    recoveryAuthKey: await deriveRecoveryAuthKey(recovery, 'alice'),
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(recovery, 'alice')),
    label: 'a',
  });
  return { env, server, client, dek };
}

describe('engine pull / syncNow', () => {
  it('A 推、B 拉 → B 拿到解密後的一致資料（含訊息樹 parentId）', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-a-${rnd()}`);
    const dbB = await device(`pull-b-${rnd()}`);

    await dbA.settings.put({ key: 'theme', value: 'dark' });
    await dbA.chats.put({
      id: 'chat_1', cardId: 'card_1', title: '第一次約會', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    await dbA.messages.bulkPut([
      { id: 'm1', chatId: 'chat_1', parentId: null, role: 'user', raw: '你好', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1 },
      { id: 'm2', chatId: 'chat_1', parentId: 'm1', role: 'assistant', raw: '走廊盡頭的風', status: 'complete', tokensIn: 0, tokensOut: 0, model: 'mock', createdAt: 2 },
    ]);
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    const out = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(out.applied).toBe(4);
    expect((await dbB.settings.get('theme'))?.value).toBe('dark');
    expect((await dbB.chats.get('chat_1'))?.title).toBe('第一次約會');
    expect((await dbB.messages.get('m2'))?.raw).toBe('走廊盡頭的風');
    expect((await dbB.messages.get('m2'))?.parentId).toBe('m1');
  });

  it('B 拉到的資料不會被當成本地變更再推回去（不迴圈）', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-c-${rnd()}`);
    const dbB = await device(`pull-d-${rnd()}`);
    await dbA.settings.put({ key: 'k', value: 'v' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });

    expect(await pendingCount(dbB)).toBe(0);
    await dbB.settings.put({ key: 'k2', value: 'v2' });
    expect(await pendingCount(dbB)).toBe(1);
  });

  it('拉取會把 rev 寫進 syncRev（下次推送才不會誤判衝突）', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-e-${rnd()}`);
    const dbB = await device(`pull-e2-${rnd()}`);
    await dbA.settings.put({ key: 'k', value: 'v1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });

    const { getRev } = await import('./engine');
    expect(await getRev(dbB, 'setting', 'k')).toBe(1);

    // B 改一下再推：baseRev=1 與雲端相符 → 不該有衝突
    await dbB.settings.put({ key: 'k', value: 'v2' });
    expect(await pushPending({ db: dbB, client, dek, deviceId: 'dev_b' })).toEqual({ pushed: 1, conflicts: 0 });
  });

  it('游標增量：第二次拉取不會重覆套用', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-f-${rnd()}`);
    const dbB = await device(`pull-g-${rnd()}`);
    await dbA.settings.put({ key: 'a', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    const first = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    const second = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  it('墓碑會刪掉本地那筆', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-h-${rnd()}`);
    const dbB = await device(`pull-i-${rnd()}`);
    await dbA.settings.put({ key: 'gone', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(await dbB.settings.get('gone')).toBeTruthy();

    await dbA.settings.delete('gone');
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(await dbB.settings.get('gone')).toBeUndefined();
  });

  it('用錯的 DEK 拉取：不寫入任何東西，也不把例外丟出去', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-j-${rnd()}`);
    const dbB = await device(`pull-k-${rnd()}`);
    await dbA.settings.put({ key: 'x', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    const wrongDek = await generateDek();
    const out = await pullChanges({ db: dbB, client, dek: wrongDek, deviceId: 'dev_b' });
    expect(out.applied).toBe(0);
    expect(await dbB.settings.get('x')).toBeUndefined();
    // 游標仍然前進：不讓一封解不開的信封卡死整條同步
    expect(out.cursor).toBeGreaterThan(0);
  });

  it('initialPush 把既有本地資料全部送上雲', async () => {
    const { env, client, dek } = await account();
    const db = await device(`pull-l-${rnd()}`);
    await db.settings.put({ key: 's1', value: '1' });
    await db.chats.put({
      id: 'chat_9', cardId: 'c', title: 't', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });

    const out = await initialPush({ db, client, dek, deviceId: 'dev_a' });
    expect(out.pushed).toBe(2);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first<{ n: number }>();
    expect(count?.n).toBe(2);
    expect(await pendingCount(db)).toBe(0);
  });

  it('syncNow 一次跑完推送與拉取', async () => {
    const { client, dek } = await account();
    const dbA = await device(`pull-m-${rnd()}`);
    const dbB = await device(`pull-n-${rnd()}`);
    await dbA.settings.put({ key: 'live', value: 'yes' });

    const a = await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    expect(a.pushed).toBe(1);

    const b = await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(b.applied).toBe(1);
    expect((await dbB.settings.get('live'))?.value).toBe('yes');

    const state = await getSyncState({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(state.cursor).toBeGreaterThan(0);
  });
});
