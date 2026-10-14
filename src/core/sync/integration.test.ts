/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { openDatabase, type DshDB } from '../storage/db';
import { installSyncTap, pendingCount } from './outbox';
import { syncNow, pushPending } from './engine';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek, unwrapDek, dekFingerprint } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);
const INVITE = 'INV-INT';

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
    // 恢復碼用 recwrap 鹽衍生的另一把金鑰包 DEK（與送伺服器的 recoveryAuthKey 無關）
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(recoveryCode, 'alice')),
    label: 'device-a',
  });
  return { env, server, client, dek, wrappedDek, master, recoveryCode };
}

describe('兩裝置整合（spec §12 驗收標準 2 / 4 / 7）', () => {
  it('驗收 2：A 發訊息 → B 拉到且解密可讀，訊息樹 parentId 完整', async () => {
    const { client, dek } = await account();
    const dbA = await device(`int-a-${rnd()}`);
    const dbB = await device(`int-b-${rnd()}`);

    await dbA.messages.bulkPut([
      { id: 'm1', chatId: 'chat_x', parentId: null, role: 'user', raw: '你好', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1 },
      { id: 'm2', chatId: 'chat_x', parentId: 'm1', role: 'assistant', raw: '走廊盡頭的風', status: 'complete', tokensIn: 0, tokensOut: 0, model: 'mock', createdAt: 2 },
    ]);
    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });

    const m2 = await dbB.messages.get('m2');
    expect(m2?.raw).toBe('走廊盡頭的風');
    expect(m2?.parentId).toBe('m1');
    expect(m2?.status).toBe('complete');
  });

  it('驗收 4：雲端找不到 apiKey / extraHeaders / baseUrl 的任何痕跡，但服務商設定解得出', async () => {
    const { env, client, dek } = await account();
    const dbA = await device(`int-c-${rnd()}`);
    await dbA.providers.put({
      id: 'prov_1',
      label: 'DeepSeek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-LEAK-CANARY-1234567890',
      extraHeaders: { 'x-canary': 'HEADER-CANARY' },
      createdAt: 1,
    });
    await dbA.modelPresets.put({
      id: 'mp_1',
      providerId: 'prov_1',
      model: 'deepseek-chat',
      params: { temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 100, contextLength: 1000, thinkingBudget: 0 },
      capabilities: { temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true, maxTokens: true, contextLength: 1000, thinkingBudget: false, prefill: false, systemRole: true },
    });
    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });

    const rows = await env.DB.prepare('SELECT kind, ciphertext FROM records').all<{ kind: string; ciphertext: string | null }>();
    const dump = JSON.stringify(rows.results);
    expect(rows.results.length).toBeGreaterThan(0);
    // 只驗長金絲雀字串：短字串（sk-、18）在 base64url 密文裡可能碰巧出現，那種斷言會隨機失敗
    expect(dump).not.toContain('LEAK-CANARY');
    expect(dump).not.toContain('HEADER-CANARY');
    expect(dump).not.toContain('deepseek.com');
    for (const row of rows.results) {
      expect(row.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    }

    // 而且另一端解開來真的有服務商設定，只是沒有秘密
    const dbB = await device(`int-d-${rnd()}`);
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    const provider = await dbB.providers.get('prov_1');
    expect(provider?.baseUrl).toBe('https://api.deepseek.com');
    // 空字串而不是 undefined：信封本來就沒帶 apiKey，套用時必須補成合法空值，
    // 否則 React 受控 input 會拿到 undefined 變成未受控元件
    expect(provider?.apiKey).toBe('');
    expect(provider?.extraHeaders).toEqual({});
  });

  it('驗收 4b：回歸——同步不會把本機的 API Key / 額外標頭清空', async () => {
    const { client, dek } = await account();
    const dbA = await device(`int-j-${rnd()}`);
    await dbA.providers.put({
      id: 'prov_1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-A-KEEP-ME-1234567890', extraHeaders: { 'x-a-canary': 'A-HEADER' }, createdAt: 1,
    });
    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });

    const dbB = await device(`int-k-${rnd()}`);
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    // B 在自己的裝置上補了金鑰（金鑰永遠不上雲，只存在這一台）
    await dbB.providers.update('prov_1', { apiKey: 'sk-B-LOCAL-1234567890', extraHeaders: { 'x-b': '1' } });
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });

    // A 把 B 推上來的版本拉回來：信封裡沒有 apiKey，套用時**不得**把 A 自己的清掉
    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    const a = await dbA.providers.get('prov_1');
    expect(a?.apiKey).toBe('sk-A-KEEP-ME-1234567890');
    expect(a?.extraHeaders).toEqual({ 'x-a-canary': 'A-HEADER' });
    // B 自己那份也不能被雲端的空版本蓋掉
    expect((await dbB.providers.get('prov_1'))?.apiKey).toBe('sk-B-LOCAL-1234567890');
  });

  it('驗收 7：離線期間的變更會補推，另一台看得到', async () => {
    const { client, dek } = await account();
    const dbA = await device(`int-e-${rnd()}`);
    const dbB = await device(`int-f-${rnd()}`);

    // 模擬離線：先不呼叫任何同步
    await dbA.settings.put({ key: 'offline1', value: '1' });
    await dbA.settings.put({ key: 'offline2', value: '2' });
    await dbA.settings.put({ key: 'offline3', value: '3' });
    expect(await pendingCount(dbA)).toBe(3);

    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    expect(await pendingCount(dbA)).toBe(0);
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect((await dbB.settings.get('offline3'))?.value).toBe('3');
  });

  it('wrappedDek 往返：同一組密碼解得回同一把 DEK；錯密碼不行', async () => {
    const { wrappedDek, dek, master } = await account();
    expect(await dekFingerprint(await unwrapDek(wrappedDek, master))).toBe(await dekFingerprint(dek));
    const wrongPassword = await deriveMasterKey('pw-999', 'alice', TEST_KDF);
    await expect(unwrapDek(wrappedDek, wrongPassword)).rejects.toThrow();
  });

  it('大量資料分批推送不會漏（45 筆跨 3 批）', async () => {
    const { client, dek } = await account();
    const dbA = await device(`int-g-${rnd()}`);
    const dbB = await device(`int-h-${rnd()}`);
    for (let i = 0; i < 45; i++) await dbA.settings.put({ key: `bulk_${i}`, value: String(i) });

    let total = 0;
    for (;;) {
      const step = await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
      total += step.pushed;
      if (step.pushed === 0) break;
    }
    expect(total).toBe(45);

    // 拉到沒有新東西為止（會跨多頁，因為 pull 上限 200 筆、推送上限 20 筆）
    let applied = 0;
    for (let i = 0; i < 10; i++) {
      const pulled = await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
      applied += pulled.applied;
      if (pulled.applied === 0 && pulled.pushed === 0) break;
    }
    expect(await dbB.settings.count()).toBe(45);
    expect(applied).toBeGreaterThanOrEqual(45);
  });

  it('未登入的本地資料不會被動到（本地優先的守門員）', async () => {
    const db = await device(`int-i-${rnd()}`);
    await db.settings.put({ key: 'local_only', value: '1' });
    expect((await db.settings.get('local_only'))?.value).toBe('1');
    // 沒登入就沒有引擎在跑，資料只留在本地
    expect(await pendingCount(db)).toBe(1);
  });
});
