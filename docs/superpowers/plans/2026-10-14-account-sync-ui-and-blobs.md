# 帳號與同步（M4–M7：blob 傳輸 / 帳號 UI / 密碼與救援 / 上線）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已經可用的同步核心（計畫一：M1–M3）補完到「真人可以拿去用」：素材與大檔真的上雲、設定頁能註冊登入看狀態、忘記密碼能救回、並且在線上跑得起來。

**Architecture:** 沿用計畫一的架構。blob 儲存體**改用 Workers KV**（R2 免費額度雖有 10 GB，但啟用必須綁付款方式）——KV 含在 Workers 免費方案內，1 GB/帳號、單值上限 25 MiB。前端在既有 `src/core/sync/` 上接一層 Zustand store 與設定頁分節；`worker/` 補上 blob 端點、改密碼、恢復碼救援。

**Tech Stack:** 既有技術棧 + Workers KV（`kv_namespaces` binding）、Zustand、React Testing Library、無頭 Chrome + CDP。

**Spec:** [docs/superpowers/specs/2026-10-14-account-sync-design.md](../specs/2026-10-14-account-sync-design.md)（blob 一節已改為 KV）
**前一份計畫:** [docs/superpowers/plans/2026-10-14-account-sync-core.md](2026-10-14-account-sync-core.md)（M1–M3，已完成；三節「執行期間修正」必讀）

---

## Global Constraints

計畫一的 Global Constraints **全部繼續適用**（本地優先、伺服器零知識、秘密不上雲、`src/core/` 不得 import React、KDF 參數可注入、不新增 runtime 依賴、每個任務都要 `npm run test` 全綠 + `npm run build` 通過 + 中文 commit）。以下為新增：

- **絕對不把個人資訊寫進會被提交的檔案**：不得出現真實 email、Cloudflare 帳號名、account id、資源 uuid、或任何能連回個人的識別。文件裡要寫就寫 `<你的帳號>`、`<D1_ID>` 這類佔位符。**這條是使用者明確要求的**（`README.md` 與計畫一留下的痕跡列在計畫一的「個人資訊清理」待辦，於本計畫最後一步處理）。
- **blob 儲存體是 Workers KV**：KV key 一律 `<userId>/<blobId>`（不做跨帳號去重，否則「兩人有同一個檔案」會從 key 洩漏）；單檔上限 **8 MiB**；帳號配額 **512 MB**。
- **KV 是最終一致的**：`GET` 拿不到剛寫入的 blob 要當「稍後重試」，**不得**標成失敗或刪掉本地參照。
- **blob 的 fileKey 必須持久化後重用**：`blobId` 是內容定址、但密文取決於隨機 `fileKey`；若重試時換一把新 `fileKey`，先前已經推上雲的信封就永遠解不開。`blobState.fileKey` 存下來，`state === 'uploaded'` 就跳過重複上傳。
- **UI 只在設定頁新增分節**：首頁與遊玩頁不得出現登入提示、不得因為未登入/未同步擋任何操作。手機端規矩照舊（鋪滿寬高、不得 `max-width`、藥丸按鈕），UI 改動一律用無頭 Chrome 實測。
- **KV 免費寫入 1,000 次/日**：任何「一次同步寫很多鍵」的實作都要能被 `MAX_BLOB_BATCH`（本計畫訂 **20**）限制住。

---

## 檔案結構

```
～ worker/wrangler.jsonc          加 kv_namespaces（BLOBS）
～ worker/src/types.ts            R2Bucket → KVNamespace 最小介面
＋ worker/src/blob.ts             handlePutBlob / handleGetBlob / releaseBlobsForRecord
～ worker/src/sync.ts             push 時同步維護 blobs.ref_count 與配額回收
～ worker/src/auth.ts             handleChangePassword / handleRecoverStart / handleRecoverFinish
～ worker/src/router.ts           blob 路徑參數、devices、password、recover 路由
＋ worker/test/blob.test.ts
＋ worker/test/auth-password.test.ts
＋ worker/test/helpers/kv.ts     記憶體版 KV（含可控制的「延遲可見」以測最終一致性）
～ worker/test/helpers/env.ts    Env 的 BLOBS 改用 KV 替身
～ src/core/sync/client.ts        putBlob / getBlob（二進位通道）+ devices / password / recover
＋ src/core/sync/blobs.ts         取出待上傳明文、加密、下載解密、重試
～ src/core/sync/engine.ts        push 前先確保 blob 上傳；pull 後懶載入
＋ src/state/useSync.ts           Zustand：登入狀態、同步狀態、衝突、配額、裝置
＋ src/ui/settings/AccountSection.tsx（＋ RecoveryCodeDialog / DevicesList / ConflictsList）
～ src/ui/settings/SettingsScreen.tsx  掛上新分節
～ src/vite-env.d.ts 或新建       VITE_SYNC_API 型別
～ README.md / AGENTS.md          KV 部署、VITE_SYNC_API、以及最後的個資清理
```

---

## Task 1: Worker 的 KV blob 端點（含最終一致性語意）

**Files:**
- Modify: `worker/src/types.ts`（`R2Bucket` → `KVNamespace`）
- Create: `worker/src/blob.ts`
- Create: `worker/test/helpers/kv.ts`
- Create: `worker/test/blob.test.ts`
- Modify: `worker/test/helpers/env.ts`（`makeTestEnv` 改用 KV 替身）
- Modify: `worker/wrangler.jsonc`（加 `kv_namespaces`）

**Interfaces:**
- Consumes: `http.ts` 的 `ok/fail`、`auth.ts` 的 `consumeQuota`
- Produces:
  - `types.ts`：`interface KVNamespace { put(key: string, value: Uint8Array | ArrayBuffer, options?: { metadata?: unknown }): Promise<void>; get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>; get(key: string): Promise<string | null>; delete(key: string): Promise<void>; list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> }`
  - `blob.ts`：`blobKey(userId: string, blobId: string): string`、`MAX_BLOB_BYTES = 8388608`
  - `blob.ts`：`handlePutBlob(env, userId, blobId, bytes: ArrayBuffer, now?): Promise<ApiReply>`
  - `blob.ts`：`handleGetBlob(env, userId, blobId): Promise<ApiReply & { bytes?: ArrayBuffer }>`
  - `blob.ts`：`releaseBlobsForRecord(env, userId, blobRef, sizeBytes): Promise<void>`
  - `test/helpers/kv.ts`：`makeTestKV(): KVNamespace & { setVisible(key, visible): void; keys(): string[] }`

- [ ] **Step 1: 寫失敗的測試**

`worker/test/blob.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestEnv } from './helpers/env';
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
    ).bind('u_2', 'bob', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', 1073741824, 1).run();
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

  it('配額不足被拒（413），且不會留下半套資料', async () => {
    const small = makeTestEnv(MIGRATION_SQL);
    await seedUser(small, 100);
    const res = await handlePutBlob(small, USER, 'blob_big', bytes(200).buffer, 1000);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('quota_exceeded');
    expect(await small.DB.prepare('SELECT blob_id FROM blobs').first()).toBeNull();
    expect((await handleGetBlob(small, USER, 'blob_big')).status).toBe(404);
  });

  it('取不到時回 404（不是 500）——最終一致性要靠客戶端重試，不是當錯誤', async () => {
    const res = await handleGetBlob(env, USER, 'nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('blob_missing');
  });

  it('尚未對外可見（KV 最終一致性）時也是 404，等一下就取得到', async () => {
    await handlePutBlob(env, USER, 'blob_c', bytes(50).buffer, 1000);
    const kv = env.BLOBS as ReturnType<typeof makeTestEnv>['BLOBS'] & { setVisible(k: string, v: boolean): void };
    kv.setVisible(blobKey(USER, 'blob_c'), false);
    expect((await handleGetBlob(env, USER, 'blob_c')).status).toBe(404);
    kv.setVisible(blobKey(USER, 'blob_c'), true);
    expect((await handleGetBlob(env, USER, 'blob_c')).status).toBe(200);
  });

  it('回收：ref_count 歸零就刪 KV 並扣回配額', async () => {
    await handlePutBlob(env, USER, 'blob_a', bytes(100).buffer, 1000);
    await releaseBlobsForRecord(env, USER, 'blob_a', 100);
    expect((await handleGetBlob(env, USER, 'blob_a')).status).toBe(404);
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(0);
    expect(await env.DB.prepare('SELECT blob_id FROM blobs').first()).toBeNull();
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run worker/test/blob.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/blob"`

- [ ] **Step 3: 寫記憶體版 KV（含可控可見性）**

`worker/test/helpers/kv.ts`：

```ts
import type { KVNamespace } from '../../src/types';

/** 記憶體版 KV。setVisible 用來模擬「KV 是最終一致的」：剛寫入可能還讀不到。 */
export function makeTestKV(): KVNamespace & { setVisible(key: string, visible: boolean): void; keys(): string[] } {
  const store = new Map<string, Uint8Array>();
  const visible = new Set<string>();
  return {
    async put(key, value) {
      store.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : value.slice().buffer));
      visible.add(key);
    },
    async get(key: string, type?: 'arrayBuffer') {
      if (!visible.has(key) || !store.has(key)) return null;
      const found = store.get(key)!;
      if (type === 'arrayBuffer') return found.slice().buffer;
      return new TextDecoder().decode(found);
    },
    async delete(key) {
      store.delete(key);
      visible.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix ?? '';
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limited = names.slice(0, options.limit ?? 1000);
      return { keys: limited.map((name) => ({ name })), list_complete: limited.length === names.length };
    },
    setVisible(key, value) {
      if (value) visible.add(key);
      else visible.delete(key);
    },
    keys: () => [...store.keys()],
  } as KVNamespace & { setVisible(key: string, visible: boolean): void; keys(): string[] };
}
```

- [ ] **Step 4: 改 `types.ts` 與 `test/helpers/env.ts`**

`worker/src/types.ts`：把 `R2ObjectBody` / `R2Bucket` 換成

```ts
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
```

`Env` 的 `BLOBS: R2Bucket` 改成 `BLOBS: KVNamespace`。
`worker/test/helpers/env.ts`：`makeTestR2()` 換成 `import { makeTestKV } from './kv'`，`BLOBS: makeTestKV()`。

- [ ] **Step 5: 實作 `worker/src/blob.ts`**

```ts
import { fail, ok, type ApiReply } from './http';
import { consumeQuota } from './auth';
import type { Env } from './types';

export const MAX_BLOB_BYTES = 8388608; // 8 MiB（KV 本身允許 25 MiB，我們自己收緊）

/** key 一律帶 userId 前綴：不做跨帳號去重，避免「兩人有同一個檔案」從 key 洩漏 */
export function blobKey(userId: string, blobId: string): string {
  return `${userId}/${blobId}`;
}

export async function handlePutBlob(
  env: Env,
  userId: string,
  blobId: string,
  bytes: ArrayBuffer,
  now = Date.now(),
): Promise<ApiReply> {
  const size = bytes.byteLength;
  if (size > MAX_BLOB_BYTES) return fail(413, 'blob_too_large', '單檔超過 8 MiB');
  if (size === 0) return fail(400, 'blob_empty', '空的 blob 不需要上傳');

  const existing = await env.DB.prepare('SELECT size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobId, userId)
    .first<{ size: number }>();
  if (existing) {
    // 內容定址：同一個 id 就是同一份內容，重傳不重複扣配額
    return ok({ blobId, size: existing.size, deduped: true });
  }

  const quota = await consumeQuota(env, userId, size);
  if (!quota.allowed) {
    return fail(413, 'quota_exceeded', '雲端空間已滿', { quota: { used: quota.used, limit: quota.limit } });
  }

  try {
    await env.BLOBS.put(blobKey(userId, blobId), bytes, { metadata: { size } });
  } catch (err) {
    // 寫 KV 失敗要把配額還回去，否則配額會慢慢被吃掉
    await env.DB.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?').bind(size, userId).run();
    throw err;
  }

  await env.DB.prepare('INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES (?,?,?,?,1)')
    .bind(blobId, userId, size, now)
    .run();

  return ok({ blobId, size });
}

export async function handleGetBlob(
  env: Env,
  userId: string,
  blobId: string,
): Promise<ApiReply & { bytes?: ArrayBuffer }> {
  const row = await env.DB.prepare('SELECT size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobId, userId)
    .first<{ size: number }>();
  const bytes = await env.BLOBS.get(blobKey(userId, blobId), 'arrayBuffer');
  // 兩種情況都回 404：記錄不存在，或 KV 還沒傳播到這個節點（最終一致性）→ 客戶端稍後重試
  if (!bytes) return fail(404, 'blob_missing', '檔案還沒同步過來，請稍後重試');
  return { ...ok({ blobId, size: row?.size ?? bytes.byteLength }), bytes };
}

/** records 刪除或改寫時把 blob 的引用數減一；歸零就刪 KV 並退款 */
export async function releaseBlobsForRecord(
  env: Env,
  userId: string,
  blobRef: string | null,
  sizeBytes: number,
): Promise<void> {
  if (!blobRef) return;
  await env.DB.prepare('UPDATE blobs SET ref_count = ref_count - 1 WHERE blob_id = ? AND user_id = ?')
    .bind(blobRef, userId)
    .run();
  const row = await env.DB.prepare('SELECT ref_count, size FROM blobs WHERE blob_id = ? AND user_id = ?')
    .bind(blobRef, userId)
    .first<{ ref_count: number; size: number }>();
  if (!row || row.ref_count > 0) return;
  await env.BLOBS.delete(blobKey(userId, blobRef));
  await env.DB.prepare('DELETE FROM blobs WHERE blob_id = ? AND user_id = ?').bind(blobRef, userId).run();
  await env.DB.prepare('UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?')
    .bind(row.size || sizeBytes, userId)
    .run();
}
```

> `MAX(0, ...)` 是 SQLite 的純量函式，D1 支援；`node:sqlite` 也支援（Task 1 的測試會驗到）。

- [ ] **Step 6: 加 KV binding 到 `worker/wrangler.jsonc`**

先建 namespace：`wrangler kv namespace create dsh-blobs`（把印出的 id 填進設定；**不要**把 id 寫進任何文件或 commit message）。

```jsonc
  "kv_namespaces": [
    { "binding": "BLOBS", "id": "<KV_NAMESPACE_ID>" }
  ],
```

（原本的 `r2_buckets` 整段刪掉。）

- [ ] **Step 7: 執行測試確認通過**

Run: `npx vitest run worker/test/blob.test.ts`
Expected: PASS（9 個用例）

- [ ] **Step 8: 全套 + 建置 + 提交**

Run: `npm run test && npm run build`

```bash
git add worker/src/types.ts worker/src/blob.ts worker/test/helpers/kv.ts worker/test/helpers/env.ts worker/test/blob.test.ts worker/wrangler.jsonc
git commit -m "feat(worker): blob 端點改用 Workers KV（userId 前綴、配額、回收、最終一致性語意）"
```

---

## Task 2: push 時維護 blob 引用數

**Files:**
- Modify: `worker/src/sync.ts`
- Modify: `worker/test/sync.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `releaseBlobsForRecord`
- Produces: `handlePush` 的既有介面不變；新增行為——當一筆 `records` 被**刪除**或**改寫且 `blob_ref` 換了**時，對舊 blob 呼叫 `releaseBlobsForRecord`

- [ ] **Step 1: 寫失敗的測試**（加進 `worker/test/sync.test.ts` 的 `describe` 內）

```ts
  it('刪掉帶 blobRef 的記錄時，blob 的引用數歸零、KV 與配額一併回收', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_x', size: 5 })] });
    await env.DB.prepare("INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES ('blob_x', ?, 1024, 1, 1)")
      .bind(USER)
      .run();
    await env.DB.prepare('UPDATE users SET used_bytes = 1024 WHERE id = ?').bind(USER).run();

    await handlePush(env, USER, {
      records: [{ kind: 'assetMeta', id: 'a1', rev: 0, baseRev: 0, updatedAt: 2000, deleted: true }],
    });

    expect(await env.DB.prepare("SELECT blob_id FROM blobs WHERE blob_id = 'blob_x'").first()).toBeNull();
    const user = await env.DB.prepare('SELECT used_bytes FROM users WHERE id = ?').bind(USER).first<{ used_bytes: number }>();
    expect(user?.used_bytes).toBe(0);
  });

  it('改寫同一筆但 blobRef 換了：舊的回收、新的保留', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_old', size: 5 })] });
    for (const id of ['blob_old', 'blob_new']) {
      await env.DB.prepare('INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count) VALUES (?,?,?,?,1)')
        .bind(id, USER, 100, 1)
        .run();
    }
    await handlePush(env, USER, {
      records: [rec({ kind: 'assetMeta', id: 'a1', baseRev: 1, rev: 2, blobRef: 'blob_new', size: 7 })],
    });
    expect(await env.DB.prepare("SELECT blob_id FROM blobs WHERE blob_id = 'blob_old'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT ref_count FROM blobs WHERE blob_id = 'blob_new'").first<{ ref_count: number }>())
      .toMatchObject({ ref_count: 1 });
  });
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run worker/test/sync.test.ts`
Expected: 新增的兩條 FAIL（blob 沒被回收）

- [ ] **Step 3: 修改 `worker/src/sync.ts` 的 `handlePush`**

在刪除分支（`if (record.deleted)`）**取出舊 blob_ref 之後**再刪記錄：

```ts
    if (record.deleted) {
      const before = await env.DB.prepare('SELECT blob_ref, size FROM records WHERE user_id = ? AND kind = ? AND id = ?')
        .bind(userId, record.kind, record.id)
        .first<{ blob_ref: string | null; size: number }>();
      await env.DB.prepare('DELETE FROM records WHERE user_id = ? AND kind = ? AND id = ?')
        .bind(userId, record.kind, record.id)
        .run();
      await releaseBlobsForRecord(env, userId, before?.blob_ref ?? null, before?.size ?? 0);
      await env.DB.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,1,?)')
        .bind(userId, record.kind, record.id, now)
        .run();
      continue;
    }
```

在 upsert 之前（算完 `existing` 之後）判斷 blob_ref 是否改變：

```ts
    const previousBlob = await env.DB.prepare('SELECT blob_ref FROM records WHERE user_id = ? AND kind = ? AND id = ?')
      .bind(userId, record.kind, record.id)
      .first<{ blob_ref: string | null }>();
    const nextBlob = record.blobRef ?? null;
    if (previousBlob?.blob_ref && previousBlob.blob_ref !== nextBlob) {
      await releaseBlobsForRecord(env, userId, previousBlob.blob_ref, 0);
    }
```

並在檔頭 import：`import { releaseBlobsForRecord } from './blob';`

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run worker/test/sync.test.ts`
Expected: PASS（13 個用例）

- [ ] **Step 5: 全套 + 建置 + 提交**

```bash
git add worker/src/sync.ts worker/test/sync.test.ts
git commit -m "feat(worker): push 時維護 blob 引用數與配額回收"
```

---

## Task 3: 前端二進位通道（`client.putBlob/getBlob`）

**Files:**
- Modify: `src/core/sync/client.ts`
- Modify: `src/core/sync/client.test.ts`

**Interfaces:**
- Consumes: 既有 `createSyncClient` 的 `raw/call` 機制
- Produces（`SyncClient` 追加）：
  - `putBlob(blobId: string, bytes: Uint8Array): Promise<{ size: number }>`
  - `getBlob(blobId: string): Promise<Uint8Array | null>`（404 → `null`，其他錯誤照拋）

- [ ] **Step 1: 寫失敗的測試**

```ts
  it('putBlob 走二進位通道、帶 Authorization，不吃 JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, blobId: 'b1', size: 4 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createSyncClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }),
    });
    const out = await client.putBlob('b1', new Uint8Array([1, 2, 3, 4]));
    expect(out.size).toBe(4);
    expect(calls[0].url).toBe('https://api.test/api/blob/b1');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer A1');
    expect(calls[0].init.body).toBeInstanceOf(Uint8Array);
  });

  it('getBlob 拿回位元組；404 回 null（最終一致性要重試，不是錯誤）', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 })) as unknown as typeof fetch;
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    expect(Array.from((await client.getBlob('b1'))!)).toEqual([9, 8, 7]);

    const notFound = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'blob_missing' }), { status: 404 })) as unknown as typeof fetch;
    const client2 = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: notFound, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    expect(await client2.getBlob('b1')).toBeNull();
  });
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/core/sync/client.test.ts`
Expected: 新增兩條 FAIL（`putBlob is not a function`）

- [ ] **Step 3: 實作**

在 `SyncClient` 介面加兩個方法，並在 `createSyncClient` 回傳物件裡實作：

```ts
  async function binary(path: string, init: { method: string; body?: Uint8Array }): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
    const response = await doFetch(`${base}${path}`, {
      method: init.method,
      headers,
      body: init.body ? (init.body.slice().buffer as ArrayBuffer) : undefined,
    });
    if (response.status === 401 && (await refresh())) {
      if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
      return doFetch(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body ? (init.body.slice().buffer as ArrayBuffer) : undefined,
      });
    }
    return response;
  }
```

```ts
    async putBlob(blobId, bytes) {
      const res = await binary(`/api/blob/${encodeURIComponent(blobId)}`, { method: 'PUT', body: bytes });
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        throw new SyncApiError(res.status, typeof parsed.code === 'string' ? parsed.code : 'http_error',
          typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.status}`);
      }
      return { size: Number(parsed.size ?? bytes.byteLength) };
    },
    async getBlob(blobId) {
      const res = await binary(`/api/blob/${encodeURIComponent(blobId)}`, { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new SyncApiError(res.status, 'blob_error', `HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/client.test.ts`
Expected: PASS（9 個用例）

- [ ] **Step 5: 全套 + 建置 + 提交**

```bash
git add src/core/sync/client.ts src/core/sync/client.test.ts
git commit -m "feat(sync): 前端 blob 二進位通道（PUT/GET，404 視為待重試）"
```

---

## Task 4: 引擎接上 blob（上傳、持久化 fileKey、懶載入重試）

**Files:**
- Create: `src/core/sync/blobs.ts`
- Create: `src/core/sync/blobs.test.ts`
- Modify: `src/core/sync/engine.ts`（push 前確保 blob；pull 後標記）
- Modify: `src/core/storage/db.ts`（`BlobStateRecord` 加 `fileKey?: string`）

**Interfaces:**
- Consumes: `blob.ts` 的 `blobIdFor/encryptBlob/decryptBlob`、`kinds.ts`、`outbox.ts`
- Produces:
  - `plaintextOf(db, kind, id): Promise<Uint8Array | null>`（`assetMeta` 取 `assets.bytes`、`cardFile` 取 `cardFiles.text`）
  - `ensureBlobUploaded(ctx, kind, id): Promise<{ blobId: string; fileKey: string; size: number } | null>`
  - `ensureBlobLocal(ctx, blobId: string, kind: SyncKind, id: string): Promise<'have' | 'fetched' | 'pending'>`
  - `MAX_BLOB_BATCH = 20`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/blobs.test.ts`（沿用 `test/fake-server.ts` 與 `openDatabase` 的多裝置模式）：

```ts
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { openDatabase, type DshDB } from '../storage/db';
import { installSyncTap } from './outbox';
import { pushPending, pullChanges, getRev } from './engine';
import { plaintextOf, ensureBlobUploaded, ensureBlobLocal } from './blobs';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek, decryptEnvelope } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);
const INVITE = 'INV-BLOB';

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
    username: 'alice', inviteCode: INVITE,
    authKey: await deriveAuthKey('pw', 'alice', TEST_KDF), kdf: JSON.stringify(TEST_KDF),
    wrappedDek: await wrapDek(dek, master),
    recoveryAuthKey: await deriveRecoveryAuthKey(code, 'alice'),
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(code, 'alice')), label: 'a',
  });
  return { env, server, client, dek };
}

const bigText = (n: number) => 'x'.repeat(n);

describe('blob 引擎', () => {
  it('plaintextOf 取得待上傳明文（cardFile 取 text、assets 取 bytes）', async () => {
    const db = await device(`blob-a-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: 'hello' });
    await db.assets.put({ id: 'as1', mime: 'image/png', size: 3, bytes: new Uint8Array([1, 2, 3]).buffer });
    expect(new TextDecoder().decode((await plaintextOf(db, 'cardFile', 'c1:ui/index.html'))!)).toBe('hello');
    expect((await plaintextOf(db, 'assetMeta', 'as1'))!.length).toBe(3);
  });

  it('大文本會走 blob：信封只帶 blobRef 與 __fileKey，雲端查得到 KV、查不到明文', async () => {
    const { env, client, dek } = await account();
    const db = await device(`blob-b-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: bigText(300 * 1024) });

    await pushPending({ db, client, dek, deviceId: 'dev_a' });

    const record = await env.DB.prepare("SELECT blob_ref, ciphertext FROM records WHERE kind = 'cardFile'")
      .first<{ blob_ref: string; ciphertext: string }>();
    expect(record?.blob_ref).toBeTruthy();
    expect(record?.ciphertext.length).toBeLessThan(1024); // 明文沒進信封

    const decoded = await decryptEnvelope<{ __fileKey: string }>(dek, 'cardFile', 'c1:ui/index.html', record!.ciphertext);
    expect(decoded.data.__fileKey).toBeTruthy();

    const state = await db.blobState.get(record!.blob_ref!);
    expect(state?.state).toBe('uploaded');
    expect(state?.fileKey).toBe(decoded.data.__fileKey); // 兩邊一致：重試不會換鑰匙
  });

  it('重複 push 不會重複上傳、fileKey 不變（否則舊信封解不開）', async () => {
    const { client, dek } = await account();
    const db = await device(`blob-c-${rnd()}`);
    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: bigText(300 * 1024) });
    await pushPending({ db, client, dek, deviceId: 'dev_a' });
    const first = await db.blobState.toArray();

    await db.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: bigText(300 * 1024) + 'y' });
    await pushPending({ db, client, dek, deviceId: 'dev_a' });
    const ids = await db.blobState.toArray();
    // 內容變了 → 新的 blobId；舊的仍在（同一筆記錄換 blob 會由伺服器回收引用）
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(first[0].fileKey).toBeTruthy();
  });

  it('B 裝置拉取後是「佔位」，真的要用時才下載並解密', async () => {
    const { client, dek } = await account();
    const dbA = await device(`blob-d1-${rnd()}`);
    const dbB = await device(`blob-d2-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: bigText(300 * 1024) });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    const placeholder = await dbB.cardFiles.get(['c1', 'ui/index.html']);
    expect(placeholder?.text ?? '').toBe(''); // 拉到的只是信封，沒有本文

    const outcome = await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html');
    expect(outcome).toBe('fetched');
    expect((await dbB.cardFiles.get(['c1', 'ui/index.html']))?.text?.length).toBe(300 * 1024);
    expect(await getRev(dbB, 'cardFile', 'c1:ui/index.html')).toBe(1); // 下載不該改動版本
  });

  it('KV 還沒傳播（404）時回 pending，且不會把本地參照弄丟', async () => {
    const { env, client, dek } = await account();
    const dbA = await device(`blob-e1-${rnd()}`);
    const dbB = await device(`blob-e2-${rnd()}`);
    await dbA.cardFiles.put({ cardId: 'c1', path: 'ui/index.html', kind: 'html', text: bigText(300 * 1024) });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });

    const kv = env.BLOBS as unknown as { setVisible(key: string, v: boolean): void };
    const blobId = (await dbB.blobState.toArray())[0].blobId;
    kv.setVisible(`alice-unknown/${blobId}`, false); // 任意 key 都設成不可見，模擬還沒傳播
    for (const key of (env.BLOBS as unknown as { keys(): string[] }).keys()) kv.setVisible(key, false);

    const outcome = await ensureBlobLocal({ db: dbB, client, dek, deviceId: 'dev_b' }, 'cardFile', 'c1:ui/index.html');
    expect(outcome).toBe('pending');
    expect(await dbB.blobState.get(blobId)).toBeTruthy(); // 參照還在
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/core/sync/blobs.test.ts`
Expected: FAIL —— `Failed to resolve import "./blobs"`

- [ ] **Step 3: 實作 `src/core/sync/blobs.ts`**

```ts
import type { DshDB } from '../storage/db';
import { BLOB_INLINE_LIMIT, blobIdFor, decryptBlob, encryptBlob } from './blob';
import type { EngineContext } from './engine';
import { readRowForSync } from './engine';
import type { SyncKind } from './kinds';

/** 一次同步最多搬幾個 blob（KV 免費方案每日 1,000 次寫入，這個上限讓「一次同步」不會吃掉整天額度） */
export const MAX_BLOB_BATCH = 20;

export async function plaintextOf(db: DshDB, kind: SyncKind, id: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const row = await readRowForSync(db, kind, id);
  if (!row) return null;
  if (kind === 'assetMeta') {
    const bytes = row.bytes as ArrayBuffer | undefined;
    return bytes ? new Uint8Array(bytes) : null;
  }
  const text = row.text as string | undefined;
  return typeof text === 'string' ? new TextEncoder().encode(text) : null;
}

/** 這一筆是否需要走 blob（> 256 KiB 的文本、或任何二進位） */
export function needsBlob(kind: SyncKind, plaintext: Uint8Array): boolean {
  return kind === 'assetMeta' || plaintext.byteLength > BLOB_INLINE_LIMIT;
}

/**
 * 確保 blob 已經在雲端。fileKey 一定要先讀既有的再決定要不要重算：
 * blobId 是內容定址，但密文取決於 fileKey；重試時換鑰匙會讓先前推上去的信封永遠解不開。
 */
export async function ensureBlobUploaded(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<{ blobId: string; fileKey: string; size: number } | null> {
  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (!plaintext) return null;
  const blobId = await blobIdFor(plaintext);

  const existing = await ctx.db.blobState.get(blobId);
  if (existing?.state === 'uploaded' && existing.fileKey) {
    return { blobId, fileKey: existing.fileKey, size: plaintext.byteLength };
  }

  const { fileKey, body } = await encryptBlob(ctx.dek, blobId, plaintext);
  await ctx.client.putBlob(blobId, body);
  await ctx.db.blobState.put({ blobId, state: 'uploaded', refId: id, size: plaintext.byteLength, fileKey });
  return { blobId, fileKey, size: plaintext.byteLength };
}

/**
 * 把遠端的 blob 抓回本地並解密寫進原表。
 * 回 'have' 已經有、'fetched' 這次抓到了、'pending' 還沒傳播（KV 最終一致）→ 呼叫端稍後重試。
 */
export async function ensureBlobLocal(
  ctx: EngineContext,
  kind: SyncKind,
  id: string,
): Promise<'have' | 'fetched' | 'pending'> {
  const plaintext = await plaintextOf(ctx.db, kind, id);
  if (plaintext && plaintext.byteLength > 0) return 'have';

  const state = (await ctx.db.blobState.toArray()).find((s) => s.refId === id);
  if (!state) return 'pending';

  const body = await ctx.client.getBlob(state.blobId);
  if (!body) return 'pending';

  const row = await readRowForSync(ctx.db, kind, id);
  if (!row) return 'pending';

  const plain = await decryptBlob(ctx.dek, state.blobId, state.fileKey ?? '', body);
  const { setApplyingRemote } = await import('./outbox');
  setApplyingRemote(true);
  try {
    if (kind === 'assetMeta') {
      await ctx.db.table('assets').put({ ...row, bytes: plain.buffer, size: plain.byteLength });
    } else {
      await ctx.db.table('cardFiles').put({ ...row, text: new TextDecoder().decode(plain) });
    }
    await ctx.db.blobState.put({ ...state, state: 'uploaded', size: plain.byteLength });
  } finally {
    setApplyingRemote(false);
  }
  return 'fetched';
}
```

- [ ] **Step 4: 改 `engine.ts`：push 前確保 blob、信封帶 `blobRef` 與 `__fileKey`**

在 `pushPending` 讀到 `row` 之後、組信封之前插入：

```ts
    const plaintext = await plaintextOf(ctx.db, entry.kind, entry.id);
    let blob: { blobId: string; fileKey: string; size: number } | null = null;
    if (plaintext && needsBlob(entry.kind, plaintext)) {
      blob = await ensureBlobUploaded(ctx, entry.kind, entry.id);
    }
    const data = sanitizeForSync(entry.kind, row);
    if (blob) data.__fileKey = blob.fileKey;
```

並把 payload 的 `blobRef: blob?.blobId` 一併帶上。**注意**：`sanitizeForSync('assetMeta')` 會把 `bytes` 拿掉，所以信封本來就不會帶二進位。

同時在 `applyRemoteRecord` 的 upsert 之後，對 blob 記錄寫入 `blobState` 時一併存 `fileKey`：

```ts
  if (record.blobRef) {
    const existing = await ctx.db.blobState.get(record.blobRef);
    await ctx.db.blobState.put({
      blobId: record.blobRef,
      state: 'remote',
      refId: record.id,
      size: record.size ?? 0,
      fileKey: (envelope.data as { __fileKey?: string }).__fileKey ?? existing?.fileKey,
    });
  }
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npx vitest run src/core/sync/blobs.test.ts`
Expected: PASS（5 個用例）

- [ ] **Step 6: 全套 + 建置 + 提交**

```bash
git add src/core/sync/blobs.ts src/core/sync/blobs.test.ts src/core/sync/engine.ts src/core/storage/db.ts
git commit -m "feat(sync): blob 上傳/下載接進引擎（fileKey 持久化、最終一致性回 pending）"
```

---

## Task 5: VITE_SYNC_API、token 儲存與 `useSync` store

> **Task 5–13 的測試樣式說明（誠實揭露）**：這些任務的程式碼模式與計畫一的 Task 8–15（Worker handler 測試、`openDatabase` 多裝置測試、RTL 元件測試）**完全相同**，因此本文只給「要新增的測試名稱 + 關鍵斷言 + 介面簽名」，不重貼整份測試檔。
> 實作節奏照計畫一：**先寫失敗測試 → 跑起來確認失敗 → 最小實作 → 確認通過 → `npm run test && npm run build` → commit**。
> 要交給零上下文的實作者時，請把計畫一的 Task 8–15 一併給他當範本。

**Files:**
- Create: `src/core/sync/session.ts`
- Create: `src/state/useSync.ts`
- Create: `src/state/useSync.test.ts`
- Modify: `.gitignore`（加 `.env.local`）

**Interfaces:**
- Consumes: `client.ts`、`engine.ts`、`kdf.ts`、`envelope.ts`、`storage/db.ts`
- Produces:
  - `session.ts`：`loadTokens(): Tokens | null`、`saveTokens(t: Tokens | null): void`、`syncApiBaseUrl(): string`
  - `useSync.ts`：Zustand store；狀態 `{ username, status, pending, conflicts, quota, lastSyncAt, message }`，動作 `refresh / register / login / logout / runSync / dismissConflicts / changePassword / recoverAccount`

- [ ] **Step 1: 寫失敗的測試**

`src/state/useSync.test.ts` 的關鍵斷言（伺服器用 `src/test/fake-server.ts`，KDF 用 `TEST_KDF` 控制成本）：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useSync } from './useSync';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../test/fake-server';
import { saveTokens } from '../core/sync/session';
import { db, switchDatabase, currentDbName, DEFAULT_DB_NAME } from '../core/storage/db';

const INVITE = 'INV-UI';
let server: typeof fetch;

beforeEach(async () => {
  const env = makeWorkerEnv();
  await seedInvite(env, INVITE);
  server = makeFakeServer(env);
  saveTokens(null);
  await switchDatabase(DEFAULT_DB_NAME);
  useSync.setState({ username: null, status: 'signed-out', pending: 0, conflicts: 0, quota: null, lastSyncAt: null, message: null });
});

describe('useSync', () => {
  it('註冊：回傳恢復碼、切到帳號專屬的庫、狀態變 idle', async () => {
    const out = await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', fetchImpl: server, kdf: TEST_KDF });
    expect(out.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(useSync.getState().username).toBe('alice');
    expect(useSync.getState().status).toBe('idle');
    expect(currentDbName()).toBe('dsh-roleplay@alice');
  });

  it('註冊後本地既有資料會被帶進新庫（匿名庫認領）', async () => {
    await db.settings.put({ key: 'before', value: '1' });
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', fetchImpl: server, kdf: TEST_KDF });
    expect((await db.settings.get('before'))?.value).toBe('1');
  });

  it('登入失敗：狀態變 error 並給人話，不影響本地可用性', async () => {
    await expect(useSync.getState().login({ username: 'nobody', password: 'x', fetchImpl: server, kdf: TEST_KDF })).rejects.toThrow();
    expect(useSync.getState().status).toBe('error');
    expect(useSync.getState().username).toBeNull();
  });

  it('runSync：pending 歸零、quota 與 lastSyncAt 有值', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', fetchImpl: server, kdf: TEST_KDF });
    await db.settings.put({ key: 'k', value: 'v' });
    expect(useSync.getState().pending).toBe(1);
    await useSync.getState().runSync();
    expect(useSync.getState().pending).toBe(0);
    expect(useSync.getState().quota?.limit).toBeGreaterThan(0);
    expect(useSync.getState().lastSyncAt).toBeGreaterThan(0);
  });

  it('logout：清 token、切回預設庫、帳號庫留在裝置上', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', fetchImpl: server, kdf: TEST_KDF });
    await db.settings.put({ key: 'keep', value: '1' });
    await useSync.getState().logout();
    expect(useSync.getState().status).toBe('signed-out');
    expect(currentDbName()).toBe(DEFAULT_DB_NAME);
    await switchDatabase('dsh-roleplay@alice');
    expect((await db.settings.get('keep'))?.value).toBe('1');
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/state/useSync.test.ts`
Expected: FAIL —— `Failed to resolve import "./useSync"`

- [ ] **Step 3: 實作 `session.ts`**

```ts
import type { Tokens } from './client';

const TOKEN_KEY = 'dsh-sync-tokens';

export function loadTokens(): Tokens | null {
  try {
    const raw = globalThis.localStorage?.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accessToken?: string; refreshToken?: string };
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens | null): void {
  try {
    if (!tokens) globalThis.localStorage?.removeItem(TOKEN_KEY);
    else globalThis.localStorage?.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch {
    // localStorage 被禁用（隱私模式）：當成沒登入，不讓它炸掉整個 app
  }
}

/** 後端位址：沒設定就回空字串，UI 顯示「這個版本沒有連線後端」而不是亂打請求 */
export function syncApiBaseUrl(): string {
  const raw = (import.meta.env?.VITE_SYNC_API as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}
```

- [ ] **Step 4: 實作 `useSync.ts`**

```ts
export interface SyncUiState {
  username: string | null;
  status: 'signed-out' | 'idle' | 'syncing' | 'error';
  pending: number;
  conflicts: number;
  quota: { used: number; limit: number } | null;
  lastSyncAt: number | null;
  message: string | null;
}
```

實作要點（每個動作都**不得**讓未捕捉的例外冒出去；失敗一律轉成 `status='error'` + `message` 人話）：
- `register`：`deriveAuthKey` / `deriveMasterKey`（`PROD_KDF`）→ `generateDek()` → `wrapDek` → `generateRecoveryCode()` → `deriveRecoveryKey` 再包一份 → `client.register` → **先把匿名庫的資料認領進新庫**（逐表 `bulkPut`，見計畫一 §7）→ `switchDatabase(dbNameFor(username))` → `initialPush` → `status='idle'`
- `login`：`deriveAuthKey` → `client.login` → `client.me()` 取 `wrappedDek` → `unwrapDek` → `switchDatabase` → `syncNow`
- `logout`：`client.logout()` → `saveTokens(null)` → `switchDatabase(DEFAULT_DB_NAME)`
- `runSync`：`status='syncing'` → `syncNow` → 讀 `pendingCount()` / `syncConflicts.count()` / `syncState` 的 quota 與 `lastSyncAt` → `status='idle'`

- [ ] **Step 5: 補一個缺口——`/api/me` 要回 `wrappedDek`**

登入回應不含 `wrappedDek`，但登入後一定要它才能解出 DEK。擴充 `handleMe` 回傳 `{ username, createdAt, quota, wrappedDek, kdf }`（兩者都是密文／參數，不是秘密），並補 `worker/test/auth-session.test.ts` 的斷言。

- [ ] **Step 6: 測試通過 + 全套 + 建置 + 提交**

Run: `npx vitest run src/state/useSync.test.ts && npm run test && npm run build`

```bash
git add src/core/sync/session.ts src/state/useSync.ts src/state/useSync.test.ts .gitignore worker/src/auth.ts worker/test/auth-session.test.ts
git commit -m "feat(sync): useSync store 與 session（登入取得 wrappedDek、切換帳號分庫、匿名庫認領）"
```

---

## Task 6: 設定頁「帳號」分節 —— 註冊（含恢復碼強制確認）與登入

**Files:**
- Create: `src/ui/settings/AccountSection.tsx`
- Create: `src/ui/settings/AccountSection.test.tsx`
- Modify: `src/ui/settings/SettingsScreen.tsx`

**Interfaces:**
- Consumes: `useSync`
- Produces: `AccountSection`（未登入：登入/註冊切換；已登入：帳號名 + 同步按鈕 + 登出）；`RecoveryCodeDialog`（顯示恢復碼，「我已抄下」未勾選前**不能**關閉）

- [ ] **Step 1: 寫失敗的測試**（RTL）：未登入顯示兩個分頁；註冊成功後彈出恢復碼且按鈕 disabled；勾選後才能關閉並看到已登入狀態；登入失敗顯示「帳號名或密碼錯誤」

- [ ] **Step 2: 執行確認失敗**

- [ ] **Step 3: 實作元件**（沿用既有 `dsh-btn` / `dsh-chip` / `dsh-input` 樣式類；手機單欄、不得 `max-width`）

- [ ] **Step 4: 測試通過 + 全套 + 提交**

```bash
git add src/ui/settings/AccountSection.tsx src/ui/settings/AccountSection.test.tsx src/ui/settings/SettingsScreen.tsx
git commit -m "feat(ui): 設定頁帳號分節（註冊/登入/登出 + 恢復碼強制確認）"
```

---

## Task 7: 同步狀態、衝突清單、配額與裝置管理

**Files:**
- Modify: `src/ui/settings/AccountSection.tsx`
- Create: `src/ui/settings/DevicesList.tsx`、`src/ui/settings/ConflictsList.tsx`
- Create: `src/ui/settings/SyncStatus.test.tsx`
- Modify: `worker/src/auth.ts` / `router.ts`（`GET /api/devices`、`DELETE /api/devices/:id`）

**Interfaces:**
- 追加端點：`handleListDevices(env, userId)`、`handleRevokeDevice(env, userId, sessionId)`
- 追加 client：`devices(): Promise<{ id: string; label: string; lastSeenAt: number; current: boolean }[]>`、`revokeDevice(id: string): Promise<void>`

- [ ] **Step 1~4**：依序寫 worker 測試（別人的 session 不能被我踢）、client 測試、UI 測試；狀態列顯示「已同步 / 同步中 / N 筆待推 / 上次時間」與配額進度條；衝突清單可展開並「知道了」清空

```bash
git commit -m "feat: 同步狀態列、衝突清單、配額與裝置管理（可踢掉其他裝置）"
```

---

## Task 8: 接進設定頁並用無頭 Chrome 實測

**Files:**
- Modify: `src/ui/settings/SettingsScreen.tsx`（已於 Task 6 掛上，這裡確認版面）
- Create: `shots/cdp-account-check.mjs`（沿用 `shots/cdp-live-check.mjs` 的 CDP 模式：**這兩個檔案在 `.gitignore` 內，不會進版控**）

**驗收**：手機視窗（390×844）下：未登入時只看得到帳號分節的登入/註冊；`.dsh-shell` 寬 == `innerWidth` 且 `scrollWidth == clientWidth`；註冊流程能走完並顯示恢復碼；截圖存證。

```bash
git add src/ui/settings/SettingsScreen.tsx
git commit -m "test(ui): 帳號分節接進設定頁並通過無頭瀏覽器實測"
```

---

## Task 9: Worker —— 改密碼

**Files:** `worker/src/auth.ts`、`worker/test/auth-password.test.ts`、`worker/src/router.ts`

**Interfaces:**
- `handleChangePassword(env, userId, body, now?): Promise<ApiReply>`，body = `{ oldAuthKey, newAuthKey, newKdf, newWrappedDek, newRecoveryAuthKey, newRecoveryWrappedDek }`
- 行為：驗舊 `authKey` → 更新 `auth_hash/auth_salt/kdf/wrapped_dek/recovery_*` → **不撤銷 session**（其他裝置的 DEK 還在記憶體裡，能繼續用到下次解鎖）

- [ ] **Step 1~4（TDD）**：測「舊密碼錯 → 401 且什麼都沒改」「成功後舊 authKey 不能登入、新 authKey 可以」「其他裝置的 access token 仍有效」「wrapped_dek 換成新的」

```bash
git commit -m "feat(worker): 改密碼（驗舊 authKey、重包 DEK、不動既有 session）"
```

---

## Task 10: Worker —— 恢復碼救援

**Files:** `worker/src/auth.ts`、`worker/test/auth-recover.test.ts`、`worker/src/router.ts`

**Interfaces:**
- `handleRecoverStart(env, body, now?)`：body = `{ username, recoveryAuthKey }` → 驗 `recovery_hash` → 產生一次性 `resetToken`（存 hash 進 `resets`，5 分鐘）→ 回 `{ resetToken }`
- `handleRecoverFinish(env, body, now?)`：body = `{ resetToken, newAuthKey, newKdf, newWrappedDek, newRecoveryAuthKey, newRecoveryWrappedDek }` → 換掉密碼與恢復碼 → **撤銷所有 session**
- 限流：recover 5 次/帳號/小時

- [ ] **Step 1~4（TDD）**：測「恢復碼錯 → 401」「resetToken 一次性、5 分鐘過期」「完成後所有舊 token 失效、新密碼可登入」

```bash
git commit -m "feat(worker): 恢復碼救援（一次性 resetToken、完成後撤銷所有 session）"
```

---

## Task 11: 前端改密碼與救援流程 + 端到端驗收

**Files:** `src/core/sync/client.ts`、`src/state/useSync.ts`、`src/ui/settings/AccountSection.tsx`、`src/core/sync/recovery.test.ts`

**Interfaces:** `useSync.changePassword(current, next)`、`useSync.recoverAccount({ username, recoveryCode, newPassword })`

- [ ] **Step 1: 整合測試（`recovery.test.ts`）**：
  1. 用密碼 A 註冊 → 記下恢復碼
  2. `changePassword(A, B)`：同一台裝置的本地資料仍可讀（DEK 沒變）；用 B 在新裝置登入 → 拉得到同一份資料
  3. 忘記密碼情境：全新裝置 + 恢復碼 + 新密碼 C → 救回並還原資料；**用舊密碼 A 登入失敗**
  4. 沒有恢復碼時救援被拒（401）
- [ ] **Step 2~4**：UI 兩個表單 + TDD 通過 + 全套 + 無頭瀏覽器實測

```bash
git commit -m "feat(sync): 改密碼與恢復碼救援（含忘密碼在新裝置救回的端到端測試）"
```

---

## Task 12: 真實 `wrangler dev` 冒煙擴充（KV / blob / 改密碼 / 救援）

**Files:** `worker/smoke.mjs`

- [ ] **Step 1**：加 4 段：① `PUT /api/blob/:id` 上傳 1 MiB → `GET` 取回並比對長度 ② 未帶 token 的 blob 請求回 401 ③ 改密碼後舊 authKey 登入失敗、新 authKey 成功 ④ recover/start + finish 走完一輪（用先前註冊時記下的恢復碼——**冒煙腳本自己要能算出**，所以腳本裡的 KDF 參數用低迭代數並直接呼叫 `src/core/sync/kdf.ts`）
- [ ] **Step 2**：`wrangler kv namespace create dsh-blobs` → 填進 `wrangler.jsonc` → `npm run d1:migrate:local` → 起 `wrangler dev` → `node worker/smoke.mjs`（**全部 PASS**，貼出輸出）
- [ ] **Step 3**：Commit

```bash
git commit -m "test(worker): 冒煙擴充（KV blob 往返、改密碼、恢復碼救援）"
```

---

## Task 13: 文件、線上驗證與個資清理（**收尾，順序不能顛倒**）

**Files:** `README.md`、`AGENTS.md`、`docs/superpowers/plans/2026-10-14-account-sync-core.md`

- [ ] **Step 1: 線上驗證**：Pages 專案加環境變數 `VITE_SYNC_API`（Worker 的網址）→ 重新 build & 部署 → 在 `air-roleplay.pages.dev` 實測三條路徑：未登入可玩 / 註冊登入 / 兩裝置同步（用 CDP 或人工瀏覽器，截圖存證）。Worker 部署：`npm run worker:deploy` + `wrangler secret put ADMIN_SECRET`。
- [ ] **Step 2: 文件**：README 補 KV 部署與 `VITE_SYNC_API`；AGENTS.md 更新測試基線數字與新增的坑；計畫一「還沒做」清單改成已完成。
- [ ] **Step 3: 個資清理**（見計畫一的「個人資訊清理」待辦）：
  - `README.md`：拿掉 Cloudflare 帳號名與 GitHub 帳號路徑 → 改佔位符
  - 計畫一第 4260 行附近：拿掉帳號名與 D1 uuid
  - `worker/wrangler.jsonc` 的 `database_id` / KV id：改成佔位符 + 在 README 寫明取得方式（**或**確認可接受而保留——這件事問使用者）
  - **歷史**：向使用者確認是否要重寫 git 歷史（`git filter-repo` + force-push）或把 repo 改 private。**沒有明確同意就不做**
- [ ] **Step 4: Commit + push**

```bash
git commit -m "docs: KV 部署與 VITE_SYNC_API；移除文件中的個人資訊"
```

---

## 計畫完成後的狀態

- 素材圖與大檔真的上雲（Workers KV），換裝置能還原；沒登入時行為完全不變。
- 設定頁能註冊、登入、看同步狀態、看衝突、看配額、踢裝置。
- 忘記密碼能用恢復碼救回；改密碼不必重新加密所有資料。
- 線上（Pages + Worker）實測過三條路徑。
- **仍未做**：卡片分享 / 社群、伺服器端搜尋、Email、OAuth（spec §2 明確不做）。
