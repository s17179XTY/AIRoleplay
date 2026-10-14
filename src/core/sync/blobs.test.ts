/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { testKV } from '../../../worker/test/helpers/kv';
import { openDatabase, type DshDB } from '../storage/db';
import { installSyncTap, pendingCount } from './outbox';
import { pushPending, pullChanges, getRev } from './engine';
import { plaintextOf, ensureBlobUploaded, ensureBlobLocal, needsBlob, MAX_BLOB_BATCH } from './blobs';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek, decryptEnvelope } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);
const INVITE = 'INV-BLOB';
const BIG = 300 * 1024; // > 256 KiB 門檻

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
  const code = generateRecoveryCode();
  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice',
    inviteCode: INVITE,
    authKey: await deriveAuthKey('pw', 'alice', TEST_KDF),
    kdf: JSON.stringify(TEST_KDF),
    wrappedDek: await wrapDek(dek, master),
    recoveryAuthKey: await deriveRecoveryAuthKey(code, 'alice'),
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(code, 'alice')),
    label: 'a',
  });
  return { env, server, client, dek };
}

describe('blob 引擎', () => {
  it('一次同步最多搬 MAX_BLOB_BATCH 個 blob（KV 每日寫入有限）', () => {
    expect(MAX_BLOB_BATCH).toBe(20);
  });

  it('plaintextOf 取得待上傳明文（cardFile 取 text、assets 取 bytes）', async () => {
    const db = await device(`blob-a-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'hello' });
    await db.assets.put({ id: 'as1', mime: 'image/png', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer });

    expect(new TextDecoder().decode((await plaintextOf(db, 'cardFile', 'c1:ui/index.html'))!)).toBe('hello');
    expect((await plaintextOf(db, 'assetMeta', 'as1'))!.length).toBe(3);
    // 其他 kind 不走 blob（訊息都是小筆文字，超過 2 MB 會被伺服器擋下並回報）
    expect(await plaintextOf(db, 'chat', 'chat_1')).toBeNull();
  });

  it('門檻判斷：二進位一律走 blob、文本超過 256 KiB 才走', () => {
    expect(needsBlob('assetMeta', new Uint8Array(1))).toBe(true);
    expect(needsBlob('cardFile', new Uint8Array(256 * 1024))).toBe(false);
    expect(needsBlob('cardFile', new Uint8Array(256 * 1024 + 1))).toBe(true);
  });

  it('大文本走 blob：信封只帶 blobRef 與 __fileKey，明文不進信封', async () => {
    const { env, client, dek } = await account();
    const db = await device(`blob-b-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'x'.repeat(BIG) });

    await pushPending({ db, client, dek, deviceId: 'dev_a' });

    const record = await env.DB.prepare("SELECT blob_ref, ciphertext FROM records WHERE kind = 'cardFile'")
      .first<{ blob_ref: string; ciphertext: string }>();
    expect(record?.blob_ref).toBeTruthy();
    expect(record!.ciphertext.length).toBeLessThan(2048); // 300 KiB 的明文不可能塞進這麼小的信封

    const decoded = await decryptEnvelope<{ __fileKey: string }>(dek, 'cardFile', 'c1:ui/index.html', record!.ciphertext);
    expect(decoded.data.__fileKey).toBeTruthy();

    const state = await db.blobState.get(record!.blob_ref!);
    expect(state?.state).toBe('uploaded');
    expect(state?.fileKey).toBe(decoded.data.__fileKey); // 兩邊一致 → 重試不會換鑰匙
    expect(state?.size).toBeGreaterThanOrEqual(BIG);
    expect(await pendingCount(db)).toBe(0);
  });

  it('重複推送不會把 fileKey 換掉（換了舊信封就永遠解不開）', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-c-${rnd()}`);
    const text = 'y'.repeat(BIG);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db, client, dek, deviceId: 'dev_a' });
    const before = (await db.blobState.toArray()).find((s) => s.refId === 'c1:ui/index.html')!;

    // 內容沒變，再推一次（模擬 ack 遺失後重試）
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db, client, dek, deviceId: 'dev_a' });
    const after = (await db.blobState.get(before.blobId))!;

    expect(after.fileKey).toBe(before.fileKey);
    expect(after.blobId).toBe(before.blobId);
  });

  it('同一個 blob 併發上傳只會送一次（KV 對同一 key 每秒限 1 次寫入）', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-race-${rnd()}`);
    await db.assets.put({ id: 'img_r', mime: 'image/png', size: 4, bytes: new Uint8Array([1, 2, 3, 4]).buffer });

    const ctx = { db, client, dek, deviceId: 'dev_a' };
    const [a, b] = await Promise.all([
      ensureBlobUploaded(ctx, 'assetMeta', 'img_r'),
      ensureBlobUploaded(ctx, 'assetMeta', 'img_r'),
    ]);
    expect(a?.blobId).toBe(b?.blobId);
    expect(a?.fileKey).toBe(b?.fileKey); // 共用同一個 promise → 不會產生兩把鑰匙
    expect((await db.blobState.toArray()).filter((s) => s.refId === 'img_r')).toHaveLength(1);
  });

  it('ensureBlobUploaded 對非 blob 種類回 null', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-c2-${rnd()}`);
    expect(await ensureBlobUploaded({ db, client, dek, deviceId: 'dev_a' }, 'chat', 'chat_1')).toBeNull();
  });

  it('B 裝置拉取後只是佔位，真的要用時才下載並解密', async () => {
    const { client, dek } = await account();
    const dbA = await device(`blob-d1-${rnd()}`);
    const dbB = await device(`blob-d2-${rnd()}`);
    const text = 'z'.repeat(BIG);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    const placeholder = await dbB.cardFiles.get(['c1', 'ui/index.html']);
    expect(placeholder?.text ?? '').toBe(''); // 拉到的只有信封
    expect((await dbB.blobState.toArray())[0].state).toBe('remote');

    const outcome = await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html');
    expect(outcome).toBe('fetched');
    expect((await dbB.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(BIG);
    expect(await getRev(dbB, 'cardFile', 'c1:ui/index.html')).toBe(1); // 下載不該改動版本
    expect(await pendingCount(dbB)).toBe(0); // 下載也不該產生待推送
  });

  it('KV 還沒傳播（404）時回 pending，而且不會弄丟本地參照', async () => {
    const { env, client, dek } = await account();
    const dbA = await device(`blob-e1-${rnd()}`);
    const dbB = await device(`blob-e2-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'w'.repeat(BIG) });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });

    const blobId = (await dbB.blobState.toArray())[0].blobId;
    const kv = testKV(env);
    for (const key of kv.keys()) kv.setVisible(key, false); // 全部假裝還沒傳播

    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html')).toBe('pending');
    expect(await dbB.blobState.get(blobId)).toBeTruthy();

    for (const key of kv.keys()) kv.setVisible(key, true);
    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html')).toBe('fetched');
  });

  it('本地已有明文時 ensureBlobLocal 直接回 have（不重複下載）', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-f-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'local' });
    expect(await ensureBlobLocal({ db, client, dek, deviceId: 'dev_a' }, 'cardFile', 'c1:ui/index.html')).toBe('have');
  });

  it('素材圖（二進位）走 blob 往返，且信封不含 bytes', async () => {
    const { env, client, dek } = await account();
    const dbA = await device(`blob-g1-${rnd()}`);
    const dbB = await device(`blob-g2-${rnd()}`);
    const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256);
    await dbA.assets.put({ id: 'img_1', mime: 'image/png', size: png.length, bytes: png.buffer });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    const record = await env.DB.prepare("SELECT blob_ref, ciphertext FROM records WHERE kind = 'assetMeta'")
      .first<{ blob_ref: string; ciphertext: string }>();
    expect(record?.blob_ref).toBeTruthy();

    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect((await dbB.assets.get('img_1'))?.bytes).toBeUndefined(); // 只有中繼資料
    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'assetMeta', 'img_1')).toBe('fetched');

    const back = new Uint8Array((await dbB.assets.get('img_1'))!.bytes);
    expect(back.length).toBe(5000);
    expect(back[100]).toBe(png[100]);
  });
});
