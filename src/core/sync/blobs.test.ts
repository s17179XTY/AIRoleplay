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
import { encryptBlob } from './blob';

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

  it('大文本走 blob：信封只帶 blobRef（v2 金鑰由 DEK+blobId 推導），明文不進信封', async () => {
    const { env, client, dek } = await account();
    const db = await device(`blob-b-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'x'.repeat(BIG) });

    await pushPending({ db, client, dek, deviceId: 'dev_a' });

    const record = await env.DB.prepare("SELECT blob_ref, ciphertext FROM records WHERE kind = 'cardFile'")
      .first<{ blob_ref: string; ciphertext: string }>();
    expect(record?.blob_ref).toBeTruthy();
    expect(record!.ciphertext.length).toBeLessThan(2048); // 300 KiB 的明文不可能塞進這麼小的信封

    const decoded = await decryptEnvelope<{ __fileKey?: string }>(dek, 'cardFile', 'c1:ui/index.html', record!.ciphertext);
    // v2 不再把隨機 fileKey 放進信封（金鑰由 DEK+blobId 決定性推導，換裝置也一致）
    expect(decoded.data.__fileKey).toBeUndefined();

    const state = await db.blobState.get(record!.blob_ref!);
    expect(state?.state).toBe('uploaded');
    expect(state?.fileKey).toBeUndefined();
    expect(state?.size).toBeGreaterThanOrEqual(BIG);
    expect(await pendingCount(db)).toBe(0);
  });

  it('重複推送重用同一個 blobId（v2 金鑰是推導的，重試不會換鑰匙）', async () => {
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

    expect(after.blobId).toBe(before.blobId);
    expect(after.state).toBe('uploaded');
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
    expect(a?.blobId).toBe(b?.blobId); // 共用同一個 promise → 不會重複上傳
    expect((await db.blobState.toArray()).filter((s) => s.refId === 'img_r')).toHaveLength(1);
  });

  it('ensureBlobUploaded 對非 blob 種類回 null', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-c2-${rnd()}`);
    expect(await ensureBlobUploaded({ db, client, dek, deviceId: 'dev_a' }, 'chat', 'chat_1')).toBeNull();
  });

  it('B 裝置拉取後會自動把 blob 補回本地（新裝置打開卡片就有互動頁）', async () => {
    const { client, dek } = await account();
    const dbA = await device(`blob-d1-${rnd()}`);
    const dbB = await device(`blob-d2-${rnd()}`);
    const text = 'z'.repeat(BIG);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    // 信封只有中繼資料，本體是拉完之後由 fetchRemoteBlobs 補上的
    expect((await dbB.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(BIG);
    expect((await dbB.blobState.toArray())[0].state).toBe('uploaded');

    // 本地已經有明文時，ensureBlobLocal 不重複下載
    const outcome = await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html');
    expect(outcome).toBe('have');
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

    // 手動在 B 造出「只有信封」的狀態：明文還沒抓回來，只有 blobId
    const source = (await dbA.blobState.toArray())[0];
    await dbB.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html' });
    await dbB.blobState.put({
      blobId: source.blobId, kind: 'cardFile', state: 'remote',
      refId: 'c1:ui/index.html', size: source.size,
    });

    const kv = testKV(env);
    for (const key of kv.keys()) kv.setVisible(key, false); // 全部假裝還沒傳播

    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html')).toBe('pending');
    expect(await dbB.blobState.get(source.blobId)).toBeTruthy();
    // pending 時仍要保住本地參照，否則就再也補不回來了
    expect((await dbB.blobState.get(source.blobId))?.blobId).toBe(source.blobId);

    for (const key of kv.keys()) kv.setVisible(key, true);
    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html')).toBe('fetched');
    expect((await dbB.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(BIG);
  });

  it('本地已有明文時 ensureBlobLocal 直接回 have（不重複下載）', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-f-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'local' });
    expect(await ensureBlobLocal({ db, client, dek, deviceId: 'dev_a' }, 'cardFile', 'c1:ui/index.html')).toBe('have');
  });

  it('換一台裝置重推同一份內容會覆寫雲端密文，第三台拉取仍然解得開（舊版「換鑰匙」bug 的根治）', async () => {
    const { env, client, dek } = await account();
    const user = await env.DB.prepare('SELECT id FROM users').first<{ id: string }>();
    const text = 'r'.repeat(BIG);

    // 裝置 A 上傳並推送
    const dbA = await device(`blob-h1-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    const blobId = (await dbA.blobState.toArray())[0].blobId;
    const kvBefore = env.BLOBS.get(`${user!.id}/${blobId}`, 'arrayBuffer') as Promise<ArrayBuffer>;
    const before = new Uint8Array(await kvBefore);

    // 裝置 C（全新本機、沒有 blobState）有同一份明文 → 重新推送，會用 v2 覆寫雲端密文
    const dbC = await device(`blob-h2-${rnd()}`);
    await dbC.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbC, client, dek, deviceId: 'dev_c' });
    const after = new Uint8Array(await (env.BLOBS.get(`${user!.id}/${blobId}`, 'arrayBuffer') as Promise<ArrayBuffer>));
    expect(Array.from(after)).not.toEqual(Array.from(before));

    // 裝置 D 拉取：信封沒有 fileKey，但 v2 金鑰由 DEK+blobId 推導 → 一定解得開
    const dbD = await device(`blob-h3-${rnd()}`);
    await pullChanges({ db: dbD, client, dek, deviceId: 'dev_d' });
    expect((await dbD.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(BIG);
  });

  it('雲端 blob 解不開時：不拋例外、標成 broken，其他資料照常同步', async () => {
    const { env, client, dek } = await account();
    const user = await env.DB.prepare('SELECT id FROM users').first<{ id: string }>();
    const text = 'b'.repeat(BIG);
    const dbA = await device(`blob-i1-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    const source = (await dbA.blobState.toArray())[0];

    // 用「另一個 DEK」加密同一份明文丟進 KV，模擬舊版同步留下的壞資料
    const otherDek = await generateDek();
    const broken = await encryptBlob(otherDek, source.blobId, new TextEncoder().encode(text), { legacy: true });
    await env.BLOBS.put(`${user!.id}/${source.blobId}`, broken.body);

    const dbB = await device(`blob-i2-${rnd()}`);
    await dbB.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html' });
    await dbB.blobState.put({
      blobId: source.blobId, kind: 'cardFile', state: 'remote',
      refId: 'c1:ui/index.html', size: source.size,
    });

    const { fetchRemoteBlobs } = await import('./engine');
    const out = await fetchRemoteBlobs({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(out.broken).toBe(1);
    expect((await dbB.blobState.get(source.blobId))?.state).toBe('broken');
  });

  it('migrateBlobKeys：本地有明文時把舊格式/blobs 重新用 v2 推上去（修復雲端）', async () => {
    const { env, client, dek } = await account();
    const user = await env.DB.prepare('SELECT id FROM users').first<{ id: string }>();
    const text = 'm'.repeat(BIG);
    const dbA = await device(`blob-j1-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    const source = (await dbA.blobState.toArray())[0];

    // 偽裝成舊版上傳（帶 fileKey）+ 把 KV 內容弄壞
    await dbA.blobState.put({ ...source, fileKey: 'legacy-key' });
    await env.BLOBS.put(`${user!.id}/${source.blobId}`, new Uint8Array([1, 2, 3]));

    const { migrateBlobKeys } = await import('./blobs');
    const out = await migrateBlobKeys({ db: dbA, client, dek, deviceId: 'dev_a' });
    expect(out.repaired).toBe(1);
    expect((await dbA.blobState.get(source.blobId))?.fileKey).toBeUndefined();

    // 新的裝置拉取 → 解密成功
    const dbB = await device(`blob-j2-${rnd()}`);
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect((await dbB.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(BIG);
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
    // 信封只帶中繼資料，本體由拉取後的 fetchRemoteBlobs 補回來
    const restored = await dbB.assets.get('img_1');
    expect(restored?.bytes).toBeTruthy();
    expect(await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'assetMeta', 'img_1')).toBe('have');

    const back = new Uint8Array((await dbB.assets.get('img_1'))!.bytes);
    expect(back.length).toBe(5000);
    expect(back[100]).toBe(png[100]);
  });
});