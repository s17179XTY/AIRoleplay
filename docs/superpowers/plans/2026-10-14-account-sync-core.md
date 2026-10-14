# 帳號與雲端同步（核心：加密層 / Worker 認證 / 同步引擎）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓這個純本地 PWA 能註冊帳號、登入，並在兩台裝置之間同步「逐筆 AES-GCM 加密」的資料，而伺服器全程看不到明文。

**Architecture:** 前端維持本地優先（Dexie 為寫入主體），新增 `src/core/sync/` 內核負責金鑰衍生、信封加解密、outbox 與增量同步；後端是獨立的 Cloudflare Worker（`worker/`）+ D1（密文與中繼資料）+ R2（大檔與素材，本計畫只做介面，實作在計畫二）。伺服器端沒有任何解密程式碼。

**Tech Stack:** TypeScript、WebCrypto（PBKDF2-SHA256 / AES-GCM）、Dexie 4（`use()` dbcore middleware）、Vite + Vitest、Cloudflare Workers + D1 + R2、`node:sqlite`（測試用的 D1 in-memory 替身，Node 24 內建，零新依賴）。

**Spec:** [docs/superpowers/specs/2026-10-14-account-sync-design.md](../specs/2026-10-14-account-sync-design.md)

**本計畫涵蓋 spec 的 M1–M3。** 計畫二（另寫）涵蓋 M4–M7：blob/R2 實際傳輸、設定頁 UI、恢復碼救援流程、AGENTS.md 與 README 文件修訂。

---

## Global Constraints

以下每一條都是專案硬規矩，**每個任務都適用**，不需要在任務裡重複：

- **本地優先**：未登入時，App 行為與現在完全一致；不得在任何 UI 路徑上擋人。
- **伺服器零知識**：`worker/` 內**不得出現任何解密程式碼**，日誌不得輸出 `ciphertext`。
- **秘密永不上雲**：`providers.apiKey` 與 `providers.extraHeaders` 不進任何上行 payload。
- **`src/core/` 四個內核不得 import React**；`src/ui/` 不得出現提示詞拼接與 HTML 解析。新增的 `src/core/sync/` 同屬內核，一樣不得 import React。
- **`messages.raw` 一旦落庫永不修改**：同步只做整筆 upsert，不得就地改寫 `raw`。
- **`Uint8Array` 的泛型要寫清楚**：TS 5.7 起 `Uint8Array` 對 buffer 泛型化，裸寫的 `Uint8Array` 等於 `Uint8Array<ArrayBufferLike>`，**傳不進 WebCrypto 的 `BufferSource`**（噴 TS2769／TS2322，而且 vitest 不會抓到，只有 `npm run build` 會）。所有會餵給 `crypto.subtle.*` 的位元組，回傳型別一律標 `Uint8Array<ArrayBuffer>`。
- **`crypto.ts`/`kdf.ts`/`envelope.ts`/`blob.ts` 不得讀模組層可變常數決定迭代數**：KDF 參數一律由呼叫端傳入（測試才能注入 1000 迭代）。
- **不得新增 runtime 依賴**（`dependencies` 不變）。唯一允許新增的是 devDependency `@types/node`。
- **不使用 `@cloudflare/vitest-pool-workers`**：Worker 的 D1 介面在測試中由 `worker/test/helpers/d1.ts`（`node:sqlite`）代替。
- **隨機失敗的斷言不准出現**：不要比對 base64url 密文裡有沒有短字串（例如 `sk-`）——密文本來就可能湊出來。要驗秘密外流，用長金絲雀字串（如 `sk-LEAK-CANARY-1234567890`）。
- **每個任務結束都要**：`npm run test` 全綠（既有 26 檔 / 93 例不得退化）、`npm run build` 通過、`git commit`（中文訊息 + `feat:` / `test:` / `chore:` 前綴）。
- **部署事實**：靜態站是 Pages 專案 `air-roleplay`（Direct Upload）；Worker 是獨立部署，不需要域名，用 `workers.dev` 子域。
- **命名**：帳號名一律小寫、3–32 字元、只允許 `[a-z0-9_-]`，保留字 `admin` / `api` / `local`。
- **限制值**（照 spec 抄，不得自行調整）：記錄信封上限 256 KiB、blob 單檔上限 8 MiB、帳號配額 1 GiB、pull 上限 200 筆、push 每批上限 20 筆（見 Task 9 的理由）。

---

## 檔案結構

計畫完成後的樣子（`＋` 新增、`～` 修改）：

```
＋ src/core/sync/bytes.ts        base64url/utf8/hex/concat 純函式
＋ src/core/sync/kdf.ts          密碼與恢復碼 → authKey / masterKey / recoveryKey
＋ src/core/sync/envelope.ts     DEK 產生與包裝、記錄信封加解密、fingerprint
＋ src/core/sync/blob.ts         blob 內容定址、fileKey 包裝、檔案格式
＋ src/core/sync/kinds.ts        14 張表 ↔ 同步信封的映射（含 provider 剝除秘密）
＋ src/core/sync/outbox.ts       Dexie dbcore middleware：唯一收斂點 + outbox 讀寫
＋ src/core/sync/client.ts       HTTP 客戶端（401 自動 refresh、退避重試）
＋ src/core/sync/engine.ts       push / pull / 首次全量 / syncNow
～ src/core/storage/db.ts        export let db、openDatabase/switchDatabase、version(2)
＋ src/test/setup.ts             補 crypto.subtle polyfill（修改既有檔）
＋ worker/wrangler.jsonc         Worker 設定（D1 + R2 綁定）
＋ worker/migrations/0001_init.sql
＋ worker/src/types.ts           Env / D1 / R2 的最小介面
＋ worker/src/http.ts            json/錯誤格式/CORS/body 解析
＋ worker/src/rate.ts            限流（rate 表）
＋ worker/src/auth.ts            註冊 / 登入 / refresh / 登出 / me / 改密碼 / 救援
＋ worker/src/sync.ts            pull / push / blob 收發
＋ worker/src/router.ts          路由分派
＋ worker/src/index.ts          fetch 入口
＋ worker/scripts/mint-invite.mjs  產生邀請碼（本機執行）
＋ worker/test/helpers/d1.ts     node:sqlite 實作的 D1 替身
＋ worker/smoke.mjs              對 wrangler dev 真打一輪的煙霧測試
＋ worker/.dev.vars              本機 admin secret（**不進版控**，Task 16 會加 .gitignore）
～ vite.config.ts                測試 include 加入 worker/**/*.test.ts
～ tsconfig.json                 include 加入 worker
～ package.json                  加 @types/node（dev）、worker:dev / d1:migrate:local 腳本
```

---

## Task 1: base64url / hex 工具與測試環境的 `crypto.subtle`

**Files:**
- Create: `src/core/sync/bytes.ts`
- Create: `src/core/sync/bytes.test.ts`
- Modify: `src/test/setup.ts`
- Modify: `package.json`（加 `@types/node`）

**Interfaces:**
- Consumes: 無
- Produces: `utf8(s: string): Uint8Array`、`fromUtf8(b: Uint8Array): string`、`toBase64Url(b: Uint8Array): string`、`fromBase64Url(s: string): Uint8Array`、`toHex(b: Uint8Array): string`、`concatBytes(...parts: Uint8Array[]): Uint8Array`

- [ ] **Step 1: 先確認 jsdom 缺 `crypto.subtle`（實測，不是聽說）**

Run: `node --input-type=module -e "import { JSDOM } from 'jsdom'; const w = new JSDOM('').window; console.log('subtle:', typeof w.crypto.subtle, '| randomUUID:', typeof w.crypto.randomUUID)"`
Expected: `subtle: undefined | randomUUID: function`

- [ ] **Step 2: 寫失敗的測試**

`src/core/sync/bytes.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { utf8, fromUtf8, toBase64Url, fromBase64Url, toHex, concatBytes } from './bytes';

describe('bytes', () => {
  it('utf8 與 fromUtf8 往返（含中文）', () => {
    expect(fromUtf8(utf8('角色扮演 ok'))).toBe('角色扮演 ok');
  });

  it('base64url 往返且不含 + / =', () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const enc = toBase64Url(src);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(enc))).toEqual(Array.from(src));
  });

  it('base64url 需要補 padding 的長度也能解回來', () => {
    for (const n of [1, 2, 3, 4, 5, 17]) {
      const src = new Uint8Array(n).fill(7);
      expect(Array.from(fromBase64Url(toBase64Url(src)))).toEqual(Array.from(src));
    }
  });

  it('toHex 補零到兩位', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('concatBytes 依序串接', () => {
    expect(Array.from(concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3])))).toEqual([1, 2, 3]);
  });

  it('測試環境有 crypto.subtle（PBKDF2 需要）', () => {
    expect(typeof globalThis.crypto.subtle).toBe('object');
  });
});
```

- [ ] **Step 3: 執行測試確認失敗**

Run: `npx vitest run src/core/sync/bytes.test.ts`
Expected: FAIL —— `Failed to resolve import "./bytes"`，且最後一條斷言也會失敗（`subtle` 是 `undefined`）

- [ ] **Step 4: 實作 `bytes.ts`**

```ts
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function toBase64Url(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
```

- [ ] **Step 5: 補 `crypto.subtle` polyfill**

`src/test/setup.ts` 改成：

```ts
/// <reference types="node" />
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom 的 crypto 只有 getRandomValues，沒有 subtle；PBKDF2 / AES-GCM 全靠它。
// 只補 subtle、不整顆換掉 crypto，是為了保住 randomUUID（db.ts 的 newId() 仰賴）。
const jsdomCrypto = globalThis.crypto as Crypto | undefined;
if (jsdomCrypto && !jsdomCrypto.subtle) {
  Object.defineProperty(jsdomCrypto, 'subtle', { value: webcrypto.subtle, configurable: true });
}

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 6: 加 `@types/node`（`/// <reference types="node" />` 需要它）**

Run: `npm i -D @types/node@^24`
Expected: `package.json` 的 `devDependencies` 多一行，`dependencies` 不變

- [ ] **Step 7: 執行測試確認通過**

Run: `npx vitest run src/core/sync/bytes.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 8: 全套測試與建置**

Run: `npm run test && npm run build`
Expected: 27 檔 / 99 例全綠；build 無錯

- [ ] **Step 9: Commit**

```bash
git add src/core/sync/bytes.ts src/core/sync/bytes.test.ts src/test/setup.ts package.json package-lock.json
git commit -m "feat(sync): base64url/hex 工具與測試環境 crypto.subtle polyfill"
```

---

## Task 2: 金鑰衍生（`kdf.ts`）

**Files:**
- Create: `src/core/sync/kdf.ts`
- Create: `src/core/sync/kdf.test.ts`

**Interfaces:**
- Consumes: `bytes.ts` 的 `utf8`、`toBase64Url`
- Produces:
  - `interface KdfParams { algo: 'PBKDF2-SHA256'; iters: number; v: 1 }`
  - `PROD_KDF: KdfParams`（600000）、`TEST_KDF: KdfParams`（1000）、`RECOVERY_ITERS = 200000`
  - `deriveAuthKey(password: string, username: string, kdf: KdfParams): Promise<string>`（base64url 32 bytes）
  - `deriveMasterKey(password: string, username: string, kdf: KdfParams): Promise<CryptoKey>`
  - `generateRecoveryCode(): string`（52 字元 Crockford Base32）
  - `normalizeRecoveryCode(input: string): string`
  - `formatRecoveryCode(code: string): string`
  - `deriveRecoveryAuthKey(code: string, username: string): Promise<string>`
  - `deriveRecoveryKey(code: string, username: string): Promise<CryptoKey>`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/kdf.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import {
  PROD_KDF, TEST_KDF, RECOVERY_ITERS,
  deriveAuthKey, deriveMasterKey,
  generateRecoveryCode, normalizeRecoveryCode, formatRecoveryCode,
  deriveRecoveryAuthKey, deriveRecoveryKey,
} from './kdf';

describe('kdf', () => {
  it('迭代數由參數決定，不是寫死的', () => {
    expect(PROD_KDF.iters).toBe(600000);
    expect(TEST_KDF.iters).toBe(1000);
    expect(RECOVERY_ITERS).toBe(200000);
  });

  it('authKey 對同帳號同密碼穩定、對大小寫帳號名一致', async () => {
    const a = await deriveAuthKey('pw-123', 'Alice', TEST_KDF);
    const b = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    const c = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('換密碼或換帳號名 → authKey 不同', async () => {
    const base = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(await deriveAuthKey('pw-124', 'alice', TEST_KDF)).not.toBe(base);
    expect(await deriveAuthKey('pw-123', 'bob', TEST_KDF)).not.toBe(base);
  });

  it('masterKey 是不可匯出的 AES-GCM 金鑰（刻意不給 exportKey 的機會）', async () => {
    const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    expect(master.algorithm.name).toBe('AES-GCM');
    expect(master.extractable).toBe(false);
    expect(master.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('authKey 是 base64url 的 32 位元組（43 個字元），不含 + / =', async () => {
    const authKey = await deriveAuthKey('pw-123', 'alice', TEST_KDF);
    expect(authKey).toHaveLength(43);
    expect(authKey).not.toMatch(/[+/=]/);
  });

  it('恢復碼格式：52 字元、Crockford 字母表、分組顯示可還原', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(normalizeRecoveryCode(formatRecoveryCode(code))).toBe(code);
  });

  it('恢復碼正規化：小寫、空白、連字號、易混淆字元都收斂', () => {
    expect(normalizeRecoveryCode('abcd-efgh ijkl')).toBe('ABCDEFGHIJKL');
    expect(normalizeRecoveryCode('O0I1L')).toBe('00111');
  });

  it('恢復碼的驗證值與解包金鑰是兩把不同的東西（零知識的關鍵）', async () => {
    const code = generateRecoveryCode();
    const authVal = await deriveRecoveryAuthKey(code, 'alice');
    const wrapKey = await deriveRecoveryKey(code, 'alice');
    expect(wrapKey.algorithm.name).toBe('AES-GCM');
    expect(wrapKey.extractable).toBe(false);
    expect(authVal).toHaveLength(43);
    expect(authVal).not.toMatch(/[+/=]/);
    // 送給伺服器的是 authVal（雜湊後入庫）；wrapKey 永不出網。
    // 兩者用不同鹽衍生，所以拿到 authVal 推不出 wrapKey——由 Task 3 的 unwrap 測試與 Task 15 的整合測試共同把關。
    expect(normalizeRecoveryCode(code)).not.toBe(authVal);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/core/sync/kdf.test.ts`
Expected: FAIL —— `Failed to resolve import "./kdf"`

- [ ] **Step 3: 實作 `kdf.ts`**

```ts
import { utf8, toBase64Url } from './bytes';

export interface KdfParams {
  algo: 'PBKDF2-SHA256';
  iters: number;
  v: 1;
}

export const PROD_KDF: KdfParams = { algo: 'PBKDF2-SHA256', iters: 600000, v: 1 };
export const TEST_KDF: KdfParams = { algo: 'PBKDF2-SHA256', iters: 1000, v: 1 };
export const RECOVERY_ITERS = 200000;

type SaltPurpose = 'auth' | 'enc' | 'recauth' | 'recwrap';

function saltFor(purpose: SaltPurpose, username: string): Uint8Array {
  return utf8(`dsh1|${purpose}|${username.toLowerCase()}`);
}

async function deriveBits(password: string, salt: Uint8Array, iters: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveAuthKey(password: string, username: string, kdf: KdfParams): Promise<string> {
  return toBase64Url(await deriveBits(password, saltFor('auth', username), kdf.iters));
}

export async function deriveMasterKey(password: string, username: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await deriveBits(password, saltFor('enc', username), kdf.iters);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode(): string {
  const raw = new Uint8Array(52);
  crypto.getRandomValues(raw);
  let out = '';
  for (let i = 0; i < raw.length; i++) out += CROCKFORD[raw[i] % 32];
  return out;
}

export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function formatRecoveryCode(code: string): string {
  return normalizeRecoveryCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

export async function deriveRecoveryAuthKey(code: string, username: string): Promise<string> {
  return toBase64Url(await deriveBits(normalizeRecoveryCode(code), saltFor('recauth', username), RECOVERY_ITERS));
}

export async function deriveRecoveryKey(code: string, username: string): Promise<CryptoKey> {
  const raw = await deriveBits(normalizeRecoveryCode(code), saltFor('recwrap', username), RECOVERY_ITERS);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
```

> `generateRecoveryCode` 用 `% 32`：256 能被 32 整除，分佈均勻，不需要拒絕取樣。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/kdf.test.ts`
Expected: PASS（7 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/kdf.ts src/core/sync/kdf.test.ts
git commit -m "feat(sync): 金鑰衍生（authKey/masterKey/恢復碼）與參數注入"
```

---

## Task 3: 信封加解密與 DEK 包裝（`envelope.ts`）

**Files:**
- Create: `src/core/sync/envelope.ts`
- Create: `src/core/sync/envelope.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`、`kdf.ts` 的 `deriveMasterKey`（測試用）
- Produces:
  - `interface Envelope<T = unknown> { v: 1; rev: number; updatedAt: number; deviceId: string; data: T }`
  - `generateDek(): Promise<CryptoKey>`（extractable=true）
  - `exportDekRaw(dek: CryptoKey): Promise<Uint8Array>`
  - `importDekRaw(raw: Uint8Array): Promise<CryptoKey>`
  - `wrapDek(dek: CryptoKey, wrappingKey: CryptoKey): Promise<string>`
  - `unwrapDek(wrapped: string, wrappingKey: CryptoKey): Promise<CryptoKey>`
  - `encryptEnvelope(dek: CryptoKey, kind: string, id: string, env: Envelope): Promise<string>`
  - `decryptEnvelope<T>(dek: CryptoKey, kind: string, id: string, ciphertext: string): Promise<Envelope<T>>`
  - `dekFingerprint(dek: CryptoKey): Promise<string>`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/envelope.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { deriveMasterKey, TEST_KDF } from './kdf';
import {
  generateDek, exportDekRaw, importDekRaw, wrapDek, unwrapDek,
  encryptEnvelope, decryptEnvelope, dekFingerprint, type Envelope,
} from './envelope';

const env = (data: unknown): Envelope => ({ v: 1, rev: 3, updatedAt: 1760412345678, deviceId: 'dev_a', data });

describe('envelope', () => {
  it('產生 DEK → 匯出 → 匯入後指紋一致', async () => {
    const dek = await generateDek();
    const again = await importDekRaw(await exportDekRaw(dek));
    expect(await dekFingerprint(again)).toBe(await dekFingerprint(dek));
    expect(await dekFingerprint(dek)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('用 masterKey 包 DEK 再解回來，能解同一封信', async () => {
    const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, master);
    const unwrapped = await unwrapDek(wrapped, master);
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ title: '秘密標題' }));
    const back = await decryptEnvelope<{ title: string }>(unwrapped, 'chat', 'chat_1', ct);
    expect(back.data.title).toBe('秘密標題');
    expect(back.rev).toBe(3);
  });

  it('信封內容不含明文（連標題都看不到）', async () => {
    const dek = await generateDek();
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ title: '不可以出現在這裡' }));
    expect(ct).not.toContain('不可以出現在這裡');
    expect(ct).not.toMatch(/[+/=]/);
  });

  it('AAD 綁定 kind 與 id：把密文搬到別的 id 會解不開', async () => {
    const dek = await generateDek();
    const ct = await encryptEnvelope(dek, 'chat', 'chat_1', env({ a: 1 }));
    await expect(decryptEnvelope(dek, 'chat', 'chat_2', ct)).rejects.toThrow();
    await expect(decryptEnvelope(dek, 'message', 'chat_1', ct)).rejects.toThrow();
  });

  it('錯的 DEK 解不開（不是回傳垃圾）', async () => {
    const ct = await encryptEnvelope(await generateDek(), 'chat', 'chat_1', env({ a: 1 }));
    await expect(decryptEnvelope(await generateDek(), 'chat', 'chat_1', ct)).rejects.toThrow();
  });

  it('錯的 masterKey 解不開 wrappedDek', async () => {
    const right = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
    const wrong = await deriveMasterKey('pw-124', 'alice', TEST_KDF);
    const wrapped = await wrapDek(await generateDek(), right);
    await expect(unwrapDek(wrapped, wrong)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/core/sync/envelope.test.ts`
Expected: FAIL —— `Failed to resolve import "./envelope"`

- [ ] **Step 3: 實作 `envelope.ts`**

```ts
import { utf8, fromUtf8, toBase64Url, fromBase64Url, toHex, concatBytes } from './bytes';

export interface Envelope<T = unknown> {
  v: 1;
  rev: number;
  updatedAt: number;
  deviceId: string;
  data: T;
}

const IV_BYTES = 12;

export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportDekRaw(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', dek));
}

export async function importDekRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

function aad(kind: string, id: string): Uint8Array {
  return utf8(`${kind}|${id}`);
}

export async function wrapDek(dek: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const raw = await exportDekRaw(dek);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw));
  return toBase64Url(concatBytes(iv, ct));
}

export async function unwrapDek(wrapped: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const all = fromBase64Url(wrapped);
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ct));
  return importDekRaw(raw);
}

export async function encryptEnvelope(dek: CryptoKey, kind: string, id: string, env: Envelope): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, id) }, dek, utf8(JSON.stringify(env))),
  );
  return toBase64Url(concatBytes(iv, ct));
}

export async function decryptEnvelope<T = unknown>(
  dek: CryptoKey,
  kind: string,
  id: string,
  ciphertext: string,
): Promise<Envelope<T>> {
  const all = fromBase64Url(ciphertext);
  const iv = all.slice(0, IV_BYTES);
  const ct = all.slice(IV_BYTES);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(kind, id) }, dek, ct),
  );
  return JSON.parse(fromUtf8(plain)) as Envelope<T>;
}

export async function dekFingerprint(dek: CryptoKey): Promise<string> {
  const raw = await exportDekRaw(dek);
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return toHex(new Uint8Array(digest));
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/envelope.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/envelope.ts src/core/sync/envelope.test.ts
git commit -m "feat(sync): DEK 包裝與逐筆 AES-GCM 信封（AAD 綁定 kind/id）"
```

---

## Task 4: blob 加密與內容定址（`blob.ts`）

**Files:**
- Create: `src/core/sync/blob.ts`
- Create: `src/core/sync/blob.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`、`envelope.ts` 的 `generateDek`
- Produces:
  - `BLOB_MAGIC: 'DSHB1'`
  - `blobIdFor(bytes: Uint8Array): Promise<string>`
  - `encryptBlob(dek: CryptoKey, blobId: string, plain: Uint8Array): Promise<{ fileKey: string; body: Uint8Array }>`
  - `decryptBlob(dek: CryptoKey, blobId: string, fileKey: string, body: Uint8Array): Promise<Uint8Array>`
  - `BLOB_INLINE_LIMIT = 262144`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/blob.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { generateDek } from './envelope';
import { blobIdFor, encryptBlob, decryptBlob, BLOB_MAGIC, BLOB_INLINE_LIMIT } from './blob';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed) % 256);

describe('blob', () => {
  it('門檻是 256 KiB（spec 寫死，不得自行調整）', () => {
    expect(BLOB_INLINE_LIMIT).toBe(262144);
  });

  it('blobId 是內容定址：同內容同 id、不同內容不同 id', async () => {
    const a = await blobIdFor(bytes(1024));
    const b = await blobIdFor(bytes(1024));
    const c = await blobIdFor(bytes(1024, 2));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('加密後的 body 以 magic 開頭，且不含明文', async () => {
    const plain = new TextEncoder().encode('這是一張不該出現在雲端的圖片'.repeat(10));
    const id = await blobIdFor(plain);
    const { fileKey, body } = await encryptBlob(await generateDek(), id, plain);
    expect(new TextDecoder().decode(body.slice(0, 5))).toBe(BLOB_MAGIC);
    expect(new TextDecoder().decode(body)).not.toContain('不該出現在雲端');
    expect(fileKey).not.toMatch(/[+/=]/);
  });

  it('解密往返一致（含 0 位元組與 1 MiB）', async () => {
    const dek = await generateDek();
    for (const size of [0, 1, 262144, 1048576]) {
      const plain = bytes(size, 7);
      const id = await blobIdFor(plain);
      const { fileKey, body } = await encryptBlob(dek, id, plain);
      const back = await decryptBlob(dek, id, fileKey, body);
      expect(back.length).toBe(size);
      expect(Array.from(back.slice(0, 16))).toEqual(Array.from(plain.slice(0, 16)));
    }
  });

  it('blobId 不符、fileKey 不對、body 被動過都會失敗', async () => {
    const dek = await generateDek();
    const plain = bytes(2048);
    const id = await blobIdFor(plain);
    const { fileKey, body } = await encryptBlob(dek, id, plain);
    await expect(decryptBlob(dek, 'other-id', fileKey, body)).rejects.toThrow();
    await expect(decryptBlob(dek, id, fileKey, new Uint8Array([...body, 1]))).rejects.toThrow();
    const tampered = body.slice();
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBlob(dek, id, fileKey, tampered)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/core/sync/blob.test.ts`
Expected: FAIL —— `Failed to resolve import "./blob"`

- [ ] **Step 3: 實作 `blob.ts`**

```ts
import { utf8, toBase64Url, fromBase64Url, concatBytes } from './bytes';

export const BLOB_INLINE_LIMIT = 262144; // 256 KiB
export const BLOB_MAGIC = 'DSHB1';
const IV_BYTES = 12;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function blobIdFor(bytes: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(bytes));
}

export async function encryptBlob(
  dek: CryptoKey,
  blobId: string,
  plain: Uint8Array,
): Promise<{ fileKey: string; body: Uint8Array }> {
  const fileKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const fileKey = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, fileKey, plain),
  );
  const body = concatBytes(utf8(BLOB_MAGIC), iv, ct);

  const wrapIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, dek, fileKeyRaw),
  );
  return { fileKey: toBase64Url(concatBytes(wrapIv, wrapped)), body };
}

export async function decryptBlob(
  dek: CryptoKey,
  blobId: string,
  fileKey: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const head = body.slice(0, BLOB_MAGIC.length);
  if (new TextDecoder().decode(head) !== BLOB_MAGIC) throw new Error('blob 格式不符');
  const iv = body.slice(BLOB_MAGIC.length, BLOB_MAGIC.length + IV_BYTES);
  const ct = body.slice(BLOB_MAGIC.length + IV_BYTES);

  const wrapped = fromBase64Url(fileKey);
  const wrapIv = wrapped.slice(0, IV_BYTES);
  const wrappedKey = wrapped.slice(IV_BYTES);
  const fileKeyRaw = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapIv }, dek, wrappedKey),
  );
  const key = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8(blobId) }, key, ct),
  );
  const actual = await blobIdFor(plain);
  if (actual !== blobId) throw new Error('blob 內容與 id 不符');
  return plain;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/blob.test.ts`
Expected: PASS（5 個用例；1 MiB 那條會花幾十毫秒）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/blob.ts src/core/sync/blob.test.ts
git commit -m "feat(sync): blob 內容定址與兩層加密（fileKey 由 DEK 包裝）"
```

---

## Task 5: 表 ↔ 信封映射與秘密剝除（`kinds.ts`）

**Files:**
- Create: `src/core/sync/kinds.ts`
- Create: `src/core/sync/kinds.test.ts`

**Interfaces:**
- Consumes: `@/core/storage/types` 的既有型別
- Produces:
  - `type SyncKind = 'card' | 'cardFile' | 'chat' | 'message' | 'memory' | 'worldbook' | 'worldbookEntry' | 'regexScript' | 'config' | 'cardUiState' | 'setting' | 'provider' | 'modelPreset' | 'assetMeta'`
  - `SYNC_TABLES: Record<SyncKind, string>`（kind → Dexie 表名）
  - `LOCAL_ONLY_TABLES: string[]`（`['syncOutbox', 'syncState', 'syncConflicts', 'blobState']`）
  - `keyOf(kind: SyncKind, row: Record<string, unknown>): string`
  - `sanitizeForSync(kind: SyncKind, row: Record<string, unknown>): Record<string, unknown>`
  - `stripLocalFields(row: Record<string, unknown>): Record<string, unknown>`（移除 `__rev`）
  - `isBlobKind(kind: SyncKind): boolean`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/kinds.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { SYNC_TABLES, LOCAL_ONLY_TABLES, keyOf, sanitizeForSync, stripLocalFields, isBlobKind } from './kinds';

describe('kinds', () => {
  it('14 種 kind 都有對應表，且本地專用表不在其中', () => {
    const tables = Object.values(SYNC_TABLES);
    expect(tables).toHaveLength(14);
    for (const t of LOCAL_ONLY_TABLES) expect(tables).not.toContain(t);
  });

  it('複合主鍵的表用「:」串成穩定 id', () => {
    expect(keyOf('cardFile', { cardId: 'card_1', path: 'ui/index.html' })).toBe('card_1:ui/index.html');
    expect(keyOf('cardUiState', { cardId: 'card_1', key: 'xp' })).toBe('card_1:xp');
  });

  it('單主鍵的表直接用 row.id', () => {
    expect(keyOf('chat', { id: 'chat_1' })).toBe('chat_1');
  });

  it('provider 剝掉 apiKey 與 extraHeaders（秘密永不上雲）', () => {
    const out = sanitizeForSync('provider', {
      id: 'prov_1', label: '中轉', protocol: 'openai', baseUrl: 'https://x',
      apiKey: 'sk-secret', extraHeaders: { Authorization: 'Bearer secret' }, createdAt: 1,
    });
    expect(out).toEqual({ id: 'prov_1', label: '中轉', protocol: 'openai', baseUrl: 'https://x', createdAt: 1 });
    expect(JSON.stringify(out)).not.toContain('sk-secret');
    expect(JSON.stringify(out)).not.toContain('Bearer secret');
  });

  it('assetMeta 只同步中繼資料，bytes 交給 blob', () => {
    const out = sanitizeForSync('assetMeta', { id: 'a1', mime: 'image/png', size: 123, bytes: new ArrayBuffer(8) });
    expect(out).toEqual({ id: 'a1', mime: 'image/png', size: 123 });
    expect(isBlobKind('assetMeta')).toBe(true);
    expect(isBlobKind('chat')).toBe(false);
  });

  it('其他 kind 原樣通過，但移除同步用的 __rev', () => {
    const row = { id: 'c1', title: 't', __rev: 4 };
    expect(sanitizeForSync('chat', row)).toEqual({ id: 'c1', title: 't', __rev: 4 });
    expect(stripLocalFields(row)).toEqual({ id: 'c1', title: 't' });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/core/sync/kinds.test.ts`
Expected: FAIL —— `Failed to resolve import "./kinds"`

- [ ] **Step 3: 實作 `kinds.ts`**

```ts
export type SyncKind =
  | 'card' | 'cardFile' | 'chat' | 'message' | 'memory'
  | 'worldbook' | 'worldbookEntry' | 'regexScript' | 'config'
  | 'cardUiState' | 'setting' | 'provider' | 'modelPreset' | 'assetMeta';

export const SYNC_TABLES: Record<SyncKind, string> = {
  card: 'cards',
  cardFile: 'cardFiles',
  chat: 'chats',
  message: 'messages',
  memory: 'memories',
  worldbook: 'worldbooks',
  worldbookEntry: 'worldbookEntries',
  regexScript: 'regexScripts',
  config: 'configs',
  cardUiState: 'cardUiState',
  setting: 'settings',
  provider: 'providers',
  modelPreset: 'modelPresets',
  assetMeta: 'assets',
};

export const LOCAL_ONLY_TABLES = ['syncOutbox', 'syncState', 'syncConflicts', 'blobState'];

/** 二進位本體走 blob 通道，信封只帶中繼資料 */
export function isBlobKind(kind: SyncKind): boolean {
  return kind === 'assetMeta';
}

export function keyOf(kind: SyncKind, row: Record<string, unknown>): string {
  if (kind === 'cardFile') return `${String(row.cardId)}:${String(row.path)}`;
  if (kind === 'cardUiState') return `${String(row.cardId)}:${String(row.key)}`;
  return String(row.id);
}

export function stripLocalFields(row: Record<string, unknown>): Record<string, unknown> {
  const { __rev: _ignored, ...rest } = row;
  return rest;
}

export function sanitizeForSync(kind: SyncKind, row: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'provider') {
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      createdAt: row.createdAt,
    };
  }
  if (kind === 'assetMeta') {
    return { id: row.id, mime: row.mime, size: row.size };
  }
  return { ...row };
}
```

> `__rev` 是同步層的本地欄位（見 Task 6）；`sanitizeForSync` 保留它是刻意的——引擎推送時要拿它算 `baseRev`，`stripLocalFields` 則是給「真的不該外流」的場合用。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/kinds.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/kinds.ts src/core/sync/kinds.test.ts
git commit -m "feat(sync): 表↔信封映射與 provider 秘密欄位剝除"
```

---

## Task 6: 可換庫的 `db` + Dexie v2 + outbox 收斂點

**Files:**
- Modify: `src/core/storage/db.ts`
- Create: `src/core/sync/outbox.ts`
- Create: `src/core/storage/db-switch.test.ts`
- Create: `src/core/sync/outbox.test.ts`

**Interfaces:**
- Consumes: `kinds.ts` 的 `SYNC_TABLES` / `LOCAL_ONLY_TABLES` / `keyOf`
- Produces:
  - `db.ts`：`export let db: DshDB`、`openDatabase(name: string): DshDB`、`switchDatabase(name: string): Promise<DshDB>`、`currentDbName(): string`、`DEFAULT_DB_NAME = 'dsh-roleplay'`、`dbNameFor(username: string): string`
  - `outbox.ts`：`installSyncTap(target: DshDB): void`、`setApplyingRemote(flag: boolean): void`、`pendingCount(target?: DshDB): Promise<number>`、`takeOutbox(limit: number, target?: DshDB): Promise<OutboxEntry[]>`、`clearOutbox(entries: OutboxEntry[], target?: DshDB): Promise<void>`、`interface OutboxEntry { kind: SyncKind; id: string; deleted: 0 | 1; queuedAt: number }`

- [ ] **Step 1: 寫失敗的測試（換庫隔離）**

`src/core/storage/db-switch.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, switchDatabase, currentDbName, dbNameFor, DEFAULT_DB_NAME } from './db';

afterEach(async () => {
  await switchDatabase(DEFAULT_DB_NAME);
});

describe('可換庫的 db', () => {
  it('DB 名稱：未登入用預設名、登入帳號各自一庫', () => {
    expect(dbNameFor('alice')).toBe('dsh-roleplay@alice');
    expect(DEFAULT_DB_NAME).toBe('dsh-roleplay');
  });

  it('切到別的庫之後，寫入不會污染原本的庫', async () => {
    const a = await switchDatabase('test-db-a');
    await a.cards.put({
      id: 'card_a', name: 'A 卡', author: '', version: '1', description: '', tags: [],
      source: 'local', spec: 'dsh-card/1', createdAt: 1, updatedAt: 1,
    });

    const b = await switchDatabase('test-db-b');
    expect(await b.cards.count()).toBe(0);

    const back = await switchDatabase('test-db-a');
    expect(await back.cards.count()).toBe(1);
    expect(currentDbName()).toBe('test-db-a');
  });

  it('v2 多了四張同步用表，既有 13 張表還在', async () => {
    const d = openDatabase('test-db-schema');
    await d.open();
    const names = d.tables.map((t) => t.name).sort();
    expect(names).toContain('syncOutbox');
    expect(names).toContain('syncState');
    expect(names).toContain('syncConflicts');
    expect(names).toContain('blobState');
    expect(names).toContain('cards');
    expect(names).toContain('cardUiState');
    d.close();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/core/storage/db-switch.test.ts`
Expected: FAIL —— `switchDatabase is not a function`

- [ ] **Step 3: 改寫 `db.ts`**

```ts
import Dexie, { type Table } from 'dexie';
import type {
  AssetRecord, CardFileRecord, CardRecord, CardUiStateRecord, ChatRecord, ConfigRecord,
  MemoryRecord, MessageRecord, ModelPresetRecord, ProviderRecord, RegexScriptRecord,
  SettingRecord, WorldbookEntryRecord, WorldbookRecord,
} from './types';

export interface OutboxRecord { kind: string; id: string; deleted: 0 | 1; queuedAt: number }
export interface SyncStateRecord { key: string; value: string }
export interface ConflictRecord {
  seq?: number; kind: string; id: string; rev: number; updatedAt: number; ciphertext: string; detectedAt: number;
}
export interface BlobStateRecord { blobId: string; state: 'local' | 'uploaded' | 'remote'; refId: string; size: number }

export const DEFAULT_DB_NAME = 'dsh-roleplay';

export function dbNameFor(username: string): string {
  return `${DEFAULT_DB_NAME}@${username.toLowerCase()}`;
}

export class DshDB extends Dexie {
  cards!: Table<CardRecord, string>;
  cardFiles!: Table<CardFileRecord, [string, string]>;
  assets!: Table<AssetRecord, string>;
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  memories!: Table<MemoryRecord, string>;
  worldbooks!: Table<WorldbookRecord, string>;
  worldbookEntries!: Table<WorldbookEntryRecord, string>;
  regexScripts!: Table<RegexScriptRecord, string>;
  providers!: Table<ProviderRecord, string>;
  modelPresets!: Table<ModelPresetRecord, string>;
  configs!: Table<ConfigRecord, string>;
  cardUiState!: Table<CardUiStateRecord, [string, string]>;
  settings!: Table<SettingRecord, string>;
  syncOutbox!: Table<OutboxRecord, [string, string]>;
  syncState!: Table<SyncStateRecord, string>;
  syncConflicts!: Table<ConflictRecord, number>;
  blobState!: Table<BlobStateRecord, string>;

  constructor(name = DEFAULT_DB_NAME) {
    super(name);
    this.version(1).stores({
      cards: 'id, updatedAt, name, *tags',
      cardFiles: '[cardId+path], cardId, kind',
      assets: 'id',
      chats: 'id, cardId, updatedAt',
      messages: 'id, chatId, parentId, [chatId+createdAt]',
      memories: 'id, chatId, [chatId+tier]',
      worldbooks: 'id',
      worldbookEntries: 'id, worldbookId, *keys',
      regexScripts: 'id, scope, chatId',
      providers: 'id',
      modelPresets: 'id, providerId',
      configs: 'id, scope, refId',
      cardUiState: '[cardId+key]',
      settings: 'key',
    });
    this.version(2).stores({
      syncOutbox: '[kind+id], kind',
      syncState: 'key',
      syncConflicts: '++seq, kind, id',
      blobState: 'blobId, state, refId',
    });
  }
}

let currentName = DEFAULT_DB_NAME;
export let db = new DshDB(currentName);

export function currentDbName(): string {
  return currentName;
}

export function openDatabase(name: string): DshDB {
  currentName = name;
  const next = new DshDB(name);
  db = next;
  return next;
}

export async function switchDatabase(name: string): Promise<DshDB> {
  if (name === currentName) {
    await db.open();
    return db;
  }
  db.close();
  const next = openDatabase(name);
  await next.open();
  return next;
}

export function newId(prefix = ''): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g && typeof g.randomUUID === 'function') return prefix + g.randomUUID();
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
```

> 全站 37 個 `db.xxx` 使用點都寫在函式體內（已掃過 `providerRepo.ts:10` 等），ESM live binding 讓它們自動跟著換庫；`import { db }` 的寫法不用動。

- [ ] **Step 4: 執行換庫測試**

Run: `npx vitest run src/core/storage/db-switch.test.ts`
Expected: PASS（3 個用例）

- [ ] **Step 5: 寫 outbox 收斂點的失敗測試**

`src/core/sync/outbox.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, currentDbName, DEFAULT_DB_NAME, switchDatabase } from '../storage/db';
import { installSyncTap, setApplyingRemote, pendingCount, takeOutbox, clearOutbox } from './outbox';

let name = '';
beforeEach(async () => {
  name = `outbox-test-${Math.random().toString(36).slice(2)}`;
  await switchDatabase(name);
  installSyncTap((await import('../storage/db')).db);
});

describe('outbox 收斂點', () => {
  it('任何寫入都會留下一筆待推送', async () => {
    const { db } = await import('../storage/db');
    await db.chats.put({
      id: 'chat_1', cardId: 'card_1', title: 't', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    expect(await pendingCount()).toBe(1);
  });

  it('同一筆改兩次只留一筆（[kind+id] 主鍵去重）', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'fontSize', value: '16' });
    await db.settings.put({ key: 'fontSize', value: '18' });
    expect(await pendingCount()).toBe(1);
  });

  it('刪除會留下墓碑標記', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'k', value: 'v' });
    await db.settings.delete('k');
    const items = await takeOutbox(10);
    expect(items).toHaveLength(1);
    expect(items[0].deleted).toBe(1);
  });

  it('bulkPut 會逐筆進 outbox', async () => {
    const { db } = await import('../storage/db');
    await db.messages.bulkPut([
      { id: 'm1', chatId: 'c1', parentId: null, role: 'user', raw: 'a', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1 },
      { id: 'm2', chatId: 'c1', parentId: 'm1', role: 'assistant', raw: 'b', status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 2 },
    ]);
    expect(await pendingCount()).toBe(2);
  });

  it('同步層自己套用遠端資料時不會回灌 outbox（不會無限迴圈）', async () => {
    const { db } = await import('../storage/db');
    setApplyingRemote(true);
    await db.settings.put({ key: 'fromServer', value: '1' });
    setApplyingRemote(false);
    expect(await pendingCount()).toBe(0);
  });

  it('本地專用表不會被攔截', async () => {
    const { db } = await import('../storage/db');
    await db.syncState.put({ key: 'cursor', value: '5' });
    expect(await pendingCount()).toBe(0);
  });

  it('clearOutbox 只清掉已推送的那些', async () => {
    const { db } = await import('../storage/db');
    await db.settings.put({ key: 'a', value: '1' });
    await db.settings.put({ key: 'b', value: '2' });
    const items = await takeOutbox(1);
    await clearOutbox(items);
    expect(await pendingCount()).toBe(1);
  });
});
```

> 檔案結尾就到上面的 `});`。不需要 `afterEach` 清理——每個測試都用隨機庫名。

- [ ] **Step 6: 執行確認失敗**

Run: `npx vitest run src/core/sync/outbox.test.ts`
Expected: FAIL —— `installSyncTap is not a function`

- [ ] **Step 7: 實作 `outbox.ts`**

```ts
import type { DshDB } from '../storage/db';
import { db as liveDb } from '../storage/db';
import { LOCAL_ONLY_TABLES, keyOf, SYNC_TABLES, type SyncKind } from './kinds';

export interface OutboxEntry {
  kind: SyncKind;
  id: string;
  deleted: 0 | 1;
  queuedAt: number;
}

const TABLE_BY_NAME = new Map<string, SyncKind>(
  Object.entries(SYNC_TABLES).map(([kind, table]) => [table, kind as SyncKind]),
);

let applyingRemote = false;

export function setApplyingRemote(flag: boolean): void {
  applyingRemote = flag;
}

function current(): DshDB {
  return liveDb;
}

export async function pendingCount(target: DshDB = current()): Promise<number> {
  return target.syncOutbox.count();
}

export async function takeOutbox(limit: number, target: DshDB = current()): Promise<OutboxEntry[]> {
  return target.syncOutbox.limit(limit).toArray() as Promise<OutboxEntry[]>;
}

export async function clearOutbox(entries: OutboxEntry[], target: DshDB = current()): Promise<void> {
  const keys = entries.map((e) => [e.kind, e.id] as [string, string]);
  await target.syncOutbox.bulkDelete(keys);
}

export function installSyncTap(target: DshDB): void {
  target.use({
    stack: 'dbcore',
    name: 'dsh-sync-outbox',
    create(downlevel) {
      const wrapped = new Map<string, unknown>();
      return {
        ...downlevel,
        table(name: string) {
          const kind = TABLE_BY_NAME.get(name);
          const inner = downlevel.table(name);
          if (!kind || LOCAL_ONLY_TABLES.includes(name)) return inner;
          const cached = wrapped.get(name);
          if (cached) return cached as typeof inner;
          let outboxTable: ReturnType<typeof downlevel.table> | null = null;
          const proxy = new Proxy(inner, {
            get(t, prop, recv) {
              const orig = Reflect.get(t, prop, recv);
              if (typeof orig !== 'function' || prop !== 'mutate') return typeof orig === 'function' ? orig.bind(t) : orig;
              return (req: { values?: unknown[]; keys?: unknown[] }) => {
                if (applyingRemote) return orig.call(t, req);

                const entries: OutboxEntry[] = [];
                const at = Date.now();
                if (Array.isArray(req.values)) {
                  for (const value of req.values) {
                    const row = value as Record<string, unknown>;
                    entries.push({ kind, id: keyOf(kind, row), deleted: 0, queuedAt: at });
                  }
                } else if (Array.isArray(req.keys)) {
                  for (const key of req.keys) {
                    const id = typeof key === 'string'
                      ? key
                      : Array.isArray(key)
                        ? key.join(':')
                        : (key as { cardId?: string; path?: string; key?: string }).cardId !== undefined
                          ? `${(key as { cardId: string }).cardId}:${(key as { path?: string; key?: string }).path ?? (key as { key?: string }).key}`
                          : String(key);
                    entries.push({ kind, id, deleted: 1, queuedAt: at });
                  }
                }

                const result = orig.call(t, req) as Promise<unknown>;
                if (entries.length === 0) return result;
                outboxTable = outboxTable ?? downlevel.table('syncOutbox');
                const writes = entries.map((e) => outboxTable!.mutate({ values: [e] }) as Promise<unknown>);
                return Promise.all([result, ...writes]).then((all) => all[0]);
              };
            },
          });
          wrapped.set(name, proxy);
          return proxy as typeof inner;
        },
      };
    },
  });
}
```

- [ ] **Step 8: 執行 outbox 測試**

Run: `npx vitest run src/core/sync/outbox.test.ts`
Expected: PASS（7 個用例）

> 若第 7 條（`clearOutbox`）或第 4 條（`bulkPut`）失敗，先確認 `mutate` 的 `req.values` 真的存在——Task 6 的實作前已用探針確認（`put`/`bulkPut` 帶 `values`、`delete` 帶 `keys`）。這是本計畫唯一「靠探針而非文件」的機制，測試就是把探針結論釘死。

- [ ] **Step 9: 全套測試與建置**

Run: `npm run test && npm run build`
Expected: 30 檔 / 105 例左右全綠（既有 93 例不得退化）

- [ ] **Step 10: Commit**

```bash
git add src/core/storage/db.ts src/core/sync/outbox.ts src/core/storage/db-switch.test.ts src/core/sync/outbox.test.ts
git commit -m "feat(storage): db 可換庫（帳號分庫）+ Dexie v2 + outbox 唯一收斂點"
```

---

## Task 7: Worker 骨架、D1 migration 與測試用 D1 替身

**Files:**
- Create: `worker/wrangler.jsonc`
- Create: `worker/migrations/0001_init.sql`
- Create: `worker/src/types.ts`
- Create: `worker/test/helpers/d1.ts`
- Create: `worker/test/d1.test.ts`
- Modify: `vite.config.ts`、`tsconfig.json`、`package.json`

**Interfaces:**
- Consumes: 無
- Produces:
  - `worker/src/types.ts`：`Env`、`D1Database`、`D1PreparedStatement`、`D1Result<T>`、`R2Bucket`
  - `worker/test/helpers/d1.ts`：`makeTestD1(seedSql?: string): D1Database & { raw: DatabaseSync }`
  - D1 資料表：`users` / `invites` / `sessions` / `records` / `changes` / `blobs` / `rate` / `resets`

- [ ] **Step 1: 擴充測試與型別設定**

`vite.config.ts`：`test.include` 改成

```ts
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'worker/**/*.test.ts'],
```

`tsconfig.json`：`include` 改成

```json
  "include": [
    "src",
    "worker",
    "vite.config.ts"
  ]
```

`package.json` scripts 增加（`worker/` 是獨立部署單元，路徑都指向它）：

```json
    "worker:dev": "wrangler dev --config worker/wrangler.jsonc",
    "worker:deploy": "wrangler deploy --config worker/wrangler.jsonc",
    "d1:migrate:local": "wrangler d1 migrations apply dsh-sync --local --config worker/wrangler.jsonc",
    "d1:migrate:remote": "wrangler d1 migrations apply dsh-sync --remote --config worker/wrangler.jsonc"
```

- [ ] **Step 2: 寫 migration**

`worker/migrations/0001_init.sql`：

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  kdf TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  auth_salt TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  recovery_wrapped_dek TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 1073741824,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_by TEXT,
  used_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_hash TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE records (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ciphertext TEXT,
  blob_ref TEXT,
  PRIMARY KEY (user_id, kind, id)
);

CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX idx_changes_user_seq ON changes(user_id, seq);

CREATE TABLE blobs (
  blob_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rate (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 3: 寫 `worker/src/types.ts`（最小介面，不裝 `@cloudflare/workers-types`）**

```ts
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

export interface R2ObjectBody {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Bucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string | string[]): Promise<void>;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ALLOWED_ORIGINS: string;
  ADMIN_SECRET: string;
}
```

- [ ] **Step 4: 寫失敗的測試（D1 替身真的會跑 SQL）**

`worker/test/d1.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestD1 } from './helpers/d1';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');

describe('測試用 D1 替身', () => {
  it('吃得下完整的 0001 migration', () => {
    const db = makeTestD1(migration);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ['users', 'invites', 'sessions', 'records', 'changes', 'blobs', 'rate', 'resets']) {
      expect(names).toContain(t);
    }
  });

  it('bind / first / all / run 行為與 D1 一致', async () => {
    const db = makeTestD1(migration);
    await db.prepare('INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
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
```

- [ ] **Step 5: 執行確認失敗**

Run: `npx vitest run worker/test/d1.test.ts`
Expected: FAIL —— `Failed to resolve import "./helpers/d1"`

- [ ] **Step 6: 實作 `worker/test/helpers/d1.ts`**

```ts
/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../../src/types';

type Params = unknown[];

function normalize(params: Params): (string | number | bigint | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'string' || typeof p === 'bigint') return p;
    if (p instanceof Uint8Array) return p;
    if (p instanceof ArrayBuffer) return new Uint8Array(p);
    return JSON.stringify(p);
  });
}

export function makeTestD1(seedSql?: string): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  if (seedSql) raw.exec(seedSql);

  function statement(query: string, params: Params = []): D1PreparedStatement {
    const self: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return statement(query, values);
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const stmt = raw.prepare(query);
        const row = stmt.get(...normalize(params)) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] ?? null) as T | null;
        return row as T;
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const stmt = raw.prepare(query);
        const rows = stmt.all(...normalize(params)) as T[];
        return { results: rows, success: true, meta: { rows_read: rows.length } };
      },
      async run(): Promise<D1Result> {
        const stmt = raw.prepare(query);
        const info = stmt.run(...normalize(params));
        return {
          results: [],
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
    return self;
  }

  const db: D1Database & { raw: DatabaseSync } = {
    raw,
    prepare: (query: string) => statement(query),
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      raw.exec('BEGIN');
      try {
        const out: D1Result[] = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(query: string) {
      raw.exec(query);
      return { count: 0, duration: 0 };
    },
  };
  return db;
}
```

> 只有 `all` / `first` / `run` / `batch` 會用到，`exec` 是給 migration 用的。

- [ ] **Step 7: 執行測試確認通過**

Run: `npx vitest run worker/test/d1.test.ts`
Expected: PASS（5 個用例）

- [ ] **Step 8: 建立 D1 資料庫與 R2 bucket，然後寫 `worker/wrangler.jsonc`**

Run: `wrangler d1 create dsh-sync`
Expected: 印出一段含 `database_id = "xxxxxxxx-xxxx-…"` 的設定片段——**把那個 id 記下來，下一步要貼進設定檔**。

Run: `wrangler r2 bucket create dsh-sync-blobs`
Expected: 建立成功（若已存在會提示）

```jsonc
{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "dsh-sync-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-14",
  "migrations_dir": "migrations",
  "vars": {
    "ALLOWED_ORIGINS": "https://air-roleplay.pages.dev"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "dsh-sync", "database_id": "填第一步建立出來的 id" }
  ],
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "dsh-sync-blobs" }
  ],
  "observability": { "enabled": true }
}
```

`worker/src/index.ts` 此時還不存在，`wrangler` 會在 Task 10 才需要它；**這一步只要檔案存在即可，不要執行 wrangler 指令**。

- [ ] **Step 9: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add worker vite.config.ts tsconfig.json package.json
git commit -m "feat(worker): Worker 骨架、D1 migration 與 node:sqlite 版 D1 測試替身"
```

---

## Task 8: 註冊與邀請碼核銷（`http.ts` / `rate.ts` / `auth.ts`）

**Files:**
- Create: `worker/src/http.ts`
- Create: `worker/src/rate.ts`
- Create: `worker/src/auth.ts`
- Create: `worker/test/auth-register.test.ts`

**Interfaces:**
- Consumes: `worker/src/types.ts`、Task 7 的 D1 migration
- Produces:
  - `http.ts`：`interface ApiReply { status: number; body: Record<string, unknown> }`、`ok(body?)`、`fail(status, code, message)`、`sha256Hex(s: string): Promise<string>`、`randomToken(bytes?: number): string`、`pbkdf2Hex(value: string, salt: string, iterations?: number): Promise<string>`、`SERVER_KDF_ITERS = 5000`
  - `rate.ts`：`allow(db, bucket, limit, windowSec, now?): Promise<boolean>`
  - `auth.ts`：`normalizeUsername(raw: unknown): string | null`、`handleRegister(env: Env, body: unknown, now?: number): Promise<ApiReply>`、`interface SessionTokens { accessToken: string; refreshToken: string }`

- [ ] **Step 1: 寫失敗的測試**

`worker/test/auth-register.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestD1 } from './helpers/d1';
import { sha256Hex } from '../src/http';
import { normalizeUsername, handleRegister } from '../src/auth';
import type { Env } from '../src/types';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');

function makeEnv(): Env {
  return { DB: makeTestD1(migration), BLOBS: { } as never, ALLOWED_ORIGINS: '*', ADMIN_SECRET: 'test-secret' };
}

const body = (over: Record<string, unknown> = {}) => ({
  username: 'alice',
  inviteCode: 'INV-TEST-0001',
  authKey: 'auth-key-b64',
  kdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
  wrappedDek: 'wrapped-dek-b64',
  recoveryAuthKey: 'recovery-auth-b64',
  recoveryWrappedDek: 'recovery-wrapped-b64',
  label: '測試機',
  ...over,
});

async function seedInvite(env: Env, code: string, opts: { expiresAt?: number | null; used?: boolean } = {}) {
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex(code), '給 alice', 1000, opts.expiresAt ?? null, opts.used ? 'someone' : null, opts.used ? 2000 : null)
    .run();
}

describe('normalizeUsername', () => {
  it('小寫化並trim，規格外的字元一律拒絕', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(normalizeUsername('a-b_c9')).toBe('a-b_c9');
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('a'.repeat(33))).toBeNull();
    expect(normalizeUsername('壞名字')).toBeNull();
    expect(normalizeUsername('admin')).toBeNull();
    expect(normalizeUsername(123)).toBeNull();
  });
});

describe('handleRegister', () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });

  it('有效邀請碼可註冊，回傳 token 對，且不存任何明文秘密', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    const reply = await handleRegister(env, body());
    expect(reply.status).toBe(200);
    expect(typeof reply.body.accessToken).toBe('string');
    expect(typeof reply.body.refreshToken).toBe('string');

    const row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind('alice').first<Record<string, unknown>>();
    expect(row?.auth_hash).not.toBe('auth-key-b64');
    expect(row?.auth_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('auth-key-b64');
    expect(row?.wrapped_dek).toBe('wrapped-dek-b64');
  });

  it('邀請碼一次性：第二次註冊同一碼會被拒', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    expect((await handleRegister(env, body())).status).toBe(200);
    const second = await handleRegister(env, body({ username: 'bob' }));
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('invite_invalid');
  });

  it('過期或已用的邀請碼被拒', async () => {
    await seedInvite(env, 'EXPIRED', { expiresAt: 500 });
    expect((await handleRegister(env, body({ inviteCode: 'EXPIRED' }), 1000)).status).toBe(403);
    await seedInvite(env, 'USED', { used: true });
    expect((await handleRegister(env, body({ inviteCode: 'USED' }), 1000)).status).toBe(403);
  });

  it('帳號名重複被拒（409）', async () => {
    await seedInvite(env, 'A1');
    await seedInvite(env, 'A2');
    await handleRegister(env, body({ inviteCode: 'A1' }));
    const dup = await handleRegister(env, body({ inviteCode: 'A2' }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('username_taken');
  });

  it('帳號名不合規則被拒（400），且不消耗邀請碼', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    const bad = await handleRegister(env, body({ username: 'Admin' }));
    expect(bad.status).toBe(400);
    const still = await env.DB.prepare('SELECT used_by FROM invites WHERE code_hash = ?').bind(await sha256Hex('INV-TEST-0001')).first<{ used_by: string | null }>();
    expect(still?.used_by).toBeNull();
  });

  it('缺少欄位被拒（400）', async () => {
    await seedInvite(env, 'INV-TEST-0001');
    expect((await handleRegister(env, { username: 'alice' })).status).toBe(400);
    expect((await handleRegister(env, body({ wrappedDek: '' }))).status).toBe(400);
  });

  it('同 IP 連續註冊超過 10 次會被限流（429）', async () => {
    for (let i = 0; i < 10; i++) await seedInvite(env, `BULK-${i}`);
    for (let i = 0; i < 10; i++) {
      const r = await handleRegister(env, body({ username: `user${i}`, inviteCode: `BULK-${i}` }), 1000, 'ip-1');
      expect(r.status).toBe(200);
    }
    await seedInvite(env, 'BULK-LAST');
    const limited = await handleRegister(env, body({ username: 'userx', inviteCode: 'BULK-LAST' }), 1000, 'ip-1');
    expect(limited.status).toBe(429);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run worker/test/auth-register.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/http"`

- [ ] **Step 3: 實作 `http.ts`**

```ts
export interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 伺服器端的 authKey 雜湊迭代數。
 * 客戶端已經用 600000 迭代把密碼壓成 authKey，離線暴破的單次成本由客戶端決定，
 * 所以這裡不需要再疊 200000（那會撞上 Workers 免費方案的 10ms CPU 上限）。
 * spec §5.2 原寫 200000，以此處為準，理由記在 spec 修訂。
 */
export const SERVER_KDF_ITERS = 5000;

export function ok(body: Record<string, unknown> = {}): ApiReply {
  return { status: 200, body: { ok: true, ...body } };
}

export function fail(status: number, code: string, message: string): ApiReply {
  return { status, body: { ok: false, code, message } };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pbkdf2Hex(value: string, salt: string, iterations = SERVER_KDF_ITERS): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations },
    base,
    256,
  );
  return toHex(new Uint8Array(bits));
}
```

- [ ] **Step 4: 實作 `rate.ts`**

```ts
import type { D1Database } from './types';

export async function allow(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSec: number,
  now = Date.now(),
): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      'INSERT INTO rate (bucket, window_start, count) VALUES (?, ?, 1) ' +
        'ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
```

- [ ] **Step 5: 實作 `auth.ts`（只做註冊，登入留給 Task 9）**

```ts
import { fail, ok, pbkdf2Hex, randomToken, sha256Hex, type ApiReply } from './http';
import { allow } from './rate';
import type { Env } from './types';

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const RESERVED_USERNAMES = new Set(['admin', 'api', 'local']);

export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_QUOTA_BYTES = 1073741824;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  if (RESERVED_USERNAMES.has(name)) return null;
  return name;
}

function requiredString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function createSession(
  env: Env,
  userId: string,
  label: string,
  now: number,
): Promise<SessionTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, label, created_at, last_seen_at, revoked) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,0)',
  )
    .bind(
      randomToken(16),
      userId,
      await sha256Hex(accessToken),
      now + ACCESS_TTL_MS,
      await sha256Hex(refreshToken),
      now + REFRESH_TTL_MS,
      label.slice(0, 60),
      now,
      now,
    )
    .run();
  return { accessToken, refreshToken };
}

export async function handleRegister(
  env: Env,
  body: unknown,
  now = Date.now(),
  clientIp = 'unknown',
): Promise<ApiReply> {
  if (!(await allow(env.DB, `register:${clientIp}`, 10, 60, now))) {
    return fail(429, 'rate_limited', '伺服器忙，稍後自動重試');
  }
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;

  const username = normalizeUsername(input.username);
  if (!username) return fail(400, 'username_invalid', '帳號名 3–32 字元，只能用小寫字母、數字、- 和 _');

  const inviteCode = requiredString(input, 'inviteCode');
  const authKey = requiredString(input, 'authKey');
  const kdf = requiredString(input, 'kdf');
  const wrappedDek = requiredString(input, 'wrappedDek');
  const recoveryAuthKey = requiredString(input, 'recoveryAuthKey');
  const recoveryWrappedDek = requiredString(input, 'recoveryWrappedDek');
  if (!inviteCode || !authKey || !kdf || !wrappedDek || !recoveryAuthKey || !recoveryWrappedDek) {
    return fail(400, 'bad_body', '缺少必要欄位');
  }

  const codeHash = await sha256Hex(inviteCode);
  const invite = await env.DB.prepare('SELECT code_hash, expires_at, used_by FROM invites WHERE code_hash = ?')
    .bind(codeHash)
    .first<{ code_hash: string; expires_at: number | null; used_by: string | null }>();
  if (!invite || invite.used_by !== null) return fail(403, 'invite_invalid', '邀請碼無效或已被使用');
  if (invite.expires_at !== null && invite.expires_at < now) return fail(403, 'invite_invalid', '邀請碼無效或已被使用');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: string }>();
  if (existing) return fail(409, 'username_taken', '這個帳號名已經有人用了');

  const userId = `u_${randomToken(12)}`;
  const authSalt = randomToken(16);
  const recoverySalt = randomToken(16);

  await env.DB.prepare(
    'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
  )
    .bind(
      userId,
      username,
      kdf,
      await pbkdf2Hex(authKey, authSalt),
      authSalt,
      wrappedDek,
      recoveryWrappedDek,
      await pbkdf2Hex(recoveryAuthKey, recoverySalt),
      recoverySalt,
      DEFAULT_QUOTA_BYTES,
      now,
    )
    .run();

  await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL')
    .bind(userId, now, codeHash)
    .run();

  const tokens = await createSession(env, userId, typeof input.label === 'string' ? input.label : '', now);
  return ok({ username, ...tokens });
}
```

- [ ] **Step 6: 執行測試確認通過**

Run: `npx vitest run worker/test/auth-register.test.ts`
Expected: PASS（9 個用例）

- [ ] **Step 7: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add worker/src/http.ts worker/src/rate.ts worker/src/auth.ts worker/test/auth-register.test.ts
git commit -m "feat(worker): 邀請碼註冊、帳號名規則、伺服器端雜湊與限流"
```

---

## Task 9: 登入 / refresh / 登出 / me（session 生命週期）

**Files:**
- Modify: `worker/src/auth.ts`
- Create: `worker/test/auth-session.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `http.ts`、`auth.ts`
- Produces（`auth.ts` 追加）：
  - `handleLogin(env: Env, body: unknown, now?: number, clientIp?: string): Promise<ApiReply>`
  - `handleRefresh(env: Env, body: unknown, now?: number): Promise<ApiReply>`
  - `handleLogout(env: Env, sessionId: string): Promise<ApiReply>`
  - `handleMe(env: Env, sessionId: string): Promise<ApiReply>`
  - `authenticate(env: Env, authorization: string | null, now?: number): Promise<{ userId: string; sessionId: string } | null>`
  - `consumeQuota(env: Env, userId: string, deltaBytes: number): Promise<{ allowed: boolean; used: number; limit: number }>`

- [ ] **Step 1: 寫失敗的測試**

`worker/test/auth-session.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestD1 } from './helpers/d1';
import { sha256Hex } from '../src/http';
import { handleRegister, handleLogin, handleRefresh, handleLogout, handleMe, authenticate } from '../src/auth';
import type { Env } from '../src/types';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
const env = (): Env => ({ DB: makeTestD1(migration), BLOBS: {} as never, ALLOWED_ORIGINS: '*', ADMIN_SECRET: 's' });

const registerBody = (inviteCode = 'INV-1') => ({
  username: 'alice', inviteCode, authKey: 'auth-key-b64', kdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
  wrappedDek: 'wrapped-dek-b64', recoveryAuthKey: 'rec-auth-b64', recoveryWrappedDek: 'rec-wrapped-b64', label: '手機',
});

async function setup() {
  const e = env();
  await e.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,?,?)')
    .bind(await sha256Hex('INV-1'), null, 1, null, null, null).run();
  const reg = await handleRegister(e, registerBody(), 1000, 'ip-1');
  return { env: e, reg };
}

describe('登入與 session', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { ctx = await setup(); });

  it('正確 authKey 可登入；錯誤 authKey 一律回同一句話', async () => {
    const good = await handleLogin(ctx.env, { username: 'ALICE', authKey: 'auth-key-b64' }, 2000, 'ip-2');
    expect(good.status).toBe(200);
    expect(typeof good.body.accessToken).toBe('string');

    const bad = await handleLogin(ctx.env, { username: 'alice', authKey: 'wrong' }, 2000, 'ip-3');
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('帳號名或密碼錯誤');

    const ghost = await handleLogin(ctx.env, { username: 'nobody', authKey: 'wrong' }, 2000, 'ip-4');
    expect(ghost.status).toBe(401);
    expect(ghost.body.message).toBe('帳號名或密碼錯誤');
  });

  it('access token 能通過 authenticate；過期就失效', async () => {
    const access = ctx.reg.body.accessToken as string;
    const hit = await authenticate(ctx.env, `Bearer ${access}`, 2000);
    expect(hit).not.toBeNull();
    const expired = await authenticate(ctx.env, `Bearer ${access}`, 2000 + 15 * 60 * 1000 + 1);
    expect(expired).toBeNull();
  });

  it('refresh 會輪替 token，舊 refresh 立刻失效', async () => {
    const oldRefresh = ctx.reg.body.refreshToken as string;
    const rotated = await handleRefresh(ctx.env, { refreshToken: oldRefresh }, 3000);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(oldRefresh);
    const reuse = await handleRefresh(ctx.env, { refreshToken: oldRefresh }, 3000);
    expect(reuse.status).toBe(401);
  });

  it('登出後 token 立刻失效（可即時撤銷）', async () => {
    const auth = await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000);
    expect(auth).not.toBeNull();
    await handleLogout(ctx.env, auth!.sessionId);
    expect(await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000)).toBeNull();
  });

  it('me 回傳帳號、配額與已用空間', async () => {
    const auth = await authenticate(ctx.env, `Bearer ${ctx.reg.body.accessToken}`, 2000);
    const me = await handleMe(ctx.env, auth!.sessionId);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('alice');
    expect(me.body.quota).toEqual({ used: 0, limit: 1073741824 });
  });

  it('畸形 Authorization 標頭不會炸', async () => {
    expect(await authenticate(ctx.env, null, 2000)).toBeNull();
    expect(await authenticate(ctx.env, 'Basic xyz', 2000)).toBeNull();
    expect(await authenticate(ctx.env, 'Bearer ', 2000)).toBeNull();
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run worker/test/auth-session.test.ts`
Expected: FAIL —— `handleLogin is not a function`

- [ ] **Step 3: 在 `auth.ts` 追加實作**

```ts
export async function handleLogin(
  env: Env,
  body: unknown,
  now = Date.now(),
  clientIp = 'unknown',
): Promise<ApiReply> {
  if (!(await allow(env.DB, `login:${clientIp}`, 10, 60, now))) {
    return fail(429, 'rate_limited', '伺服器忙，稍後自動重試');
  }
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as Record<string, unknown>;
  const username = normalizeUsername(input.username);
  const authKey = requiredString(input, 'authKey');
  if (!username || !authKey) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const user = await env.DB.prepare('SELECT id, auth_hash, auth_salt FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; auth_hash: string; auth_salt: string }>();
  if (!user) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const candidate = await pbkdf2Hex(authKey, user.auth_salt);
  if (candidate !== user.auth_hash) return fail(401, 'bad_credentials', '帳號名或密碼錯誤');

  const tokens = await createSession(env, user.id, typeof input.label === 'string' ? input.label : '', now);
  return ok({ username, ...tokens });
}

export async function handleRefresh(env: Env, body: unknown, now = Date.now()): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const refreshToken = requiredString(body as Record<string, unknown>, 'refreshToken');
  if (!refreshToken) return fail(401, 'bad_refresh', '登入狀態已過期');

  const hash = await sha256Hex(refreshToken);
  const session = await env.DB.prepare(
    'SELECT id, user_id FROM sessions WHERE refresh_hash = ? AND revoked = 0 AND refresh_expires_at > ?',
  )
    .bind(hash, now)
    .first<{ id: string; user_id: string }>();
  if (!session) return fail(401, 'bad_refresh', '登入狀態已過期');

  const accessToken = randomToken();
  const nextRefresh = randomToken();
  await env.DB.prepare(
    'UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_seen_at = ? WHERE id = ?',
  )
    .bind(
      await sha256Hex(accessToken),
      now + ACCESS_TTL_MS,
      await sha256Hex(nextRefresh),
      now + REFRESH_TTL_MS,
      now,
      session.id,
    )
    .run();

  return ok({ accessToken, refreshToken: nextRefresh });
}

export async function authenticate(
  env: Env,
  authorization: string | null,
  now = Date.now(),
): Promise<{ userId: string; sessionId: string } | null> {
  if (!authorization || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    'SELECT id, user_id FROM sessions WHERE access_hash = ? AND revoked = 0 AND access_expires_at > ?',
  )
    .bind(await sha256Hex(token), now)
    .first<{ id: string; user_id: string }>();
  if (!session) return null;
  return { userId: session.user_id, sessionId: session.id };
}

export async function handleLogout(env: Env, sessionId: string): Promise<ApiReply> {
  await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(sessionId).run();
  return ok();
}

export async function handleMe(env: Env, sessionId: string): Promise<ApiReply> {
  const row = await env.DB.prepare(
    'SELECT u.username, u.created_at, u.used_bytes, u.quota_bytes FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
  )
    .bind(sessionId)
    .first<{ username: string; created_at: number; used_bytes: number; quota_bytes: number }>();
  if (!row) return fail(401, 'unauthorized', '請先登入');
  return ok({
    username: row.username,
    createdAt: row.created_at,
    quota: { used: row.used_bytes, limit: row.quota_bytes },
  });
}

export async function consumeQuota(
  env: Env,
  userId: string,
  deltaBytes: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const row = await env.DB.prepare(
    'UPDATE users SET used_bytes = used_bytes + ? WHERE id = ? AND used_bytes + ? <= quota_bytes RETURNING used_bytes, quota_bytes',
  )
    .bind(deltaBytes, userId, deltaBytes)
    .first<{ used_bytes: number; quota_bytes: number }>();
  if (row) return { allowed: true, used: row.used_bytes, limit: row.quota_bytes };
  const current = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();
  return { allowed: false, used: current?.used_bytes ?? 0, limit: current?.quota_bytes ?? 0 };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run worker/test/auth-session.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add worker/src/auth.ts worker/test/auth-session.test.ts
git commit -m "feat(worker): 登入、refresh 輪替、登出撤銷、me 與配額扣減"
```

---

## Task 10: 同步端點（pull / push）與測試用 Env

**Files:**
- Create: `worker/src/sync.ts`
- Create: `worker/test/helpers/env.ts`
- Create: `worker/test/sync.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `authenticate`、`consumeQuota`；Task 7 的 `types.ts`
- Produces:
  - `MAX_PULL_LIMIT = 200`、`MAX_PUSH_BATCH = 20`、`MAX_ROW_BYTES = 262144`、`CONFLICT_INLINE_BYTES = 65536`
  - `handlePull(env: Env, userId: string, cursor: number, limit?: number): Promise<ApiReply>`
  - `handlePush(env: Env, userId: string, body: unknown, now?: number): Promise<ApiReply>`
  - `worker/test/helpers/env.ts`：`makeTestEnv(seedSql: string): Env`（D1 用 `makeTestD1`，R2 用記憶體 Map）
  - `interface PushRecord { kind: string; id: string; rev: number; baseRev: number; updatedAt: number; deleted?: boolean; size?: number; ciphertext?: string; blobRef?: string }`

- [ ] **Step 1: 寫失敗的測試**

`worker/test/sync.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from './helpers/env';
import { handlePull, handlePush, MAX_PUSH_BATCH, MAX_ROW_BYTES } from '../src/sync';
import type { Env } from '../src/types';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
const USER = 'u_1';

const rec = (over: Record<string, unknown> = {}) => ({
  kind: 'chat', id: 'chat_1', rev: 1, baseRev: 0, updatedAt: 1000,
  size: 10, ciphertext: 'CT-1', ...over,
});

async function seedUser(env: Env) {
  await env.DB.prepare(
    'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
  ).bind(USER, 'alice', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', 1000, 1).run();
}

describe('sync push/pull', () => {
  let env: Env;
  beforeEach(async () => { env = makeTestEnv(migration); await seedUser(env); });

  it('新記錄直接入庫，並在 changes 追加一筆', async () => {
    const res = await handlePush(env, USER, { records: [rec()] });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([{ kind: 'chat', id: 'chat_1', rev: 1 }]);
    const change = await env.DB.prepare('SELECT seq, deleted FROM changes WHERE user_id = ?').bind(USER).first<{ seq: number; deleted: number }>();
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
    const row = await env.DB.prepare('SELECT rev FROM records WHERE user_id = ? AND kind = ? AND id = ?').bind(USER, 'chat', 'chat_1').first();
    expect(row).toBeNull();
    const last = await env.DB.prepare('SELECT deleted FROM changes WHERE user_id = ? ORDER BY seq DESC LIMIT 1').bind(USER).first<{ deleted: number }>();
    expect(last?.deleted).toBe(1);
  });

  it('pull 依 seq 游標增量回傳，刪除項不帶密文', async () => {
    await handlePush(env, USER, { records: [rec()] });
    await handlePush(env, USER, { records: [rec({ id: 'chat_2', ciphertext: 'CT-2' })] });
    const first = await handlePull(env, USER, 0);
    expect((first.body.records as unknown[]).length).toBe(2);
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
    expect((page.body.records as unknown[]).length).toBe(2);
    expect(page.body.hasMore).toBe(true);
    expect(page.body.cursor).toBe(2);
  });

  it('別的帳號的資料不會出現在我的 pull 裡', async () => {
    await env.DB.prepare(
      'INSERT INTO users (id, username, kdf, auth_hash, auth_salt, wrapped_dek, recovery_wrapped_dek, recovery_hash, recovery_salt, quota_bytes, used_bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)',
    ).bind('u_2', 'bob', '{}', 'h', 's', 'w', 'rw', 'rh', 'rs', 1000, 1).run();
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

  it('blobRef 會記進 records 並維持 ref_count', async () => {
    await handlePush(env, USER, { records: [rec({ kind: 'assetMeta', id: 'a1', blobRef: 'blob_x', size: 5 })] });
    const row = await env.DB.prepare('SELECT blob_ref FROM records WHERE id = ?').bind('a1').first<{ blob_ref: string }>();
    expect(row?.blob_ref).toBe('blob_x');
  });
});
```

- [ ] **Step 2: 寫測試用 Env helper**

`worker/test/helpers/env.ts`：

```ts
/// <reference types="node" />
import { makeTestD1 } from './d1';
import type { Env, R2Bucket } from '../../src/types';

export function makeTestR2(): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, value) { store.set(key, value.slice()); return { key }; },
    async get(key) {
      const found = store.get(key);
      if (!found) return null;
      return { size: found.length, arrayBuffer: async () => found.slice().buffer };
    },
    async head(key) { const found = store.get(key); return found ? { size: found.length } : null; },
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
  };
}

export function makeTestEnv(seedSql: string, over: Partial<Env> = {}): Env {
  return {
    DB: makeTestD1(seedSql),
    BLOBS: makeTestR2(),
    ALLOWED_ORIGINS: 'https://air-roleplay.pages.dev',
    ADMIN_SECRET: 'test-secret',
    ...over,
  };
}
```

- [ ] **Step 3: 執行確認失敗**

Run: `npx vitest run worker/test/sync.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/sync"`

- [ ] **Step 4: 實作 `worker/src/sync.ts`**

```ts
import { fail, ok, type ApiReply } from './http';
import { consumeQuota } from './auth';
import type { Env } from './types';

export const MAX_PULL_LIMIT = 200;
/** 每次 Worker 呼叫的 D1 查詢數在免費方案只有 50：20 筆 × (1 upsert + 1 change) + 讀取 ≈ 45，留一點餘裕 */
export const MAX_PUSH_BATCH = 20;
export const MAX_ROW_BYTES = 262144;
export const CONFLICT_INLINE_BYTES = 65536;
const PAIR_CHUNK = 50; // D1 單次查詢最多 100 個綁定參數

export interface PushRecord {
  kind: string;
  id: string;
  rev: number;
  baseRev: number;
  updatedAt: number;
  deleted?: boolean;
  size?: number;
  ciphertext?: string;
  blobRef?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function handlePull(
  env: Env,
  userId: string,
  cursor: number,
  limit = MAX_PULL_LIMIT,
): Promise<ApiReply> {
  const take = Math.max(1, Math.min(limit, MAX_PULL_LIMIT));
  const changes = await env.DB.prepare(
    'SELECT seq, kind, id, deleted FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  )
    .bind(userId, cursor, take)
    .all<{ seq: number; kind: string; id: string; deleted: number }>();

  const nextCursor = changes.results.length > 0 ? changes.results[changes.results.length - 1].seq : cursor;
  const live = changes.results.filter((c) => c.deleted === 0);

  const recordMap = new Map<string, Record<string, unknown>>();
  for (const group of chunk(live, PAIR_CHUNK)) {
    const clause = group.map(() => '(kind = ? AND id = ?)').join(' OR ');
    const params: unknown[] = [userId];
    for (const g of group) params.push(g.kind, g.id);
    const rows = await env.DB.prepare(
      `SELECT kind, id, rev, updated_at, size, ciphertext, blob_ref FROM records WHERE user_id = ? AND (${clause})`,
    )
      .bind(...params)
      .all<Record<string, unknown>>();
    for (const row of rows.results) recordMap.set(`${row.kind}|${row.id}`, row);
  }

  const records = changes.results.map((c) => {
    if (c.deleted === 1) return { kind: c.kind, id: c.id, deleted: true };
    const row = recordMap.get(`${c.kind}|${c.id}`);
    if (!row) return { kind: c.kind, id: c.id, deleted: true };
    return {
      kind: row.kind,
      id: row.id,
      deleted: false,
      rev: row.rev,
      updatedAt: row.updated_at,
      size: row.size,
      ciphertext: row.ciphertext,
      blobRef: row.blob_ref ?? undefined,
    };
  });

  const user = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();

  return ok({
    cursor: nextCursor,
    hasMore: changes.results.length === take,
    records,
    quota: { used: user?.used_bytes ?? 0, limit: user?.quota_bytes ?? 0 },
  });
}

export async function handlePush(
  env: Env,
  userId: string,
  body: unknown,
  now = Date.now(),
): Promise<ApiReply> {
  if (typeof body !== 'object' || body === null) return fail(400, 'bad_body', '請求格式錯誤');
  const input = body as { records?: PushRecord[] };
  if (!Array.isArray(input.records)) return fail(400, 'bad_body', '缺少 records');
  if (input.records.length > MAX_PUSH_BATCH) return fail(400, 'batch_too_large', `每批最多 ${MAX_PUSH_BATCH} 筆`);

  const accepted: Array<{ kind: string; id: string; rev: number }> = [];
  const conflicts: Array<Record<string, unknown>> = [];
  let addedBytes = 0;

  for (const record of input.records) {
    if (typeof record.kind !== 'string' || typeof record.id !== 'string') {
      return fail(400, 'bad_record', '記錄缺少 kind 或 id');
    }

    if (record.deleted) {
      await env.DB.prepare('DELETE FROM records WHERE user_id = ? AND kind = ? AND id = ?')
        .bind(userId, record.kind, record.id)
        .run();
      await env.DB.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,1,?)')
        .bind(userId, record.kind, record.id, now)
        .run();
      continue;
    }

    const size = record.size ?? (record.ciphertext ?? '').length;
    if (size > MAX_ROW_BYTES) return fail(413, 'row_too_large', '單筆記錄超過 256 KiB，請走 blob');
    if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0) {
      return fail(400, 'bad_record', '記錄缺少 ciphertext');
    }

    const existing = await env.DB.prepare('SELECT rev, size, ciphertext FROM records WHERE user_id = ? AND kind = ? AND id = ?')
      .bind(userId, record.kind, record.id)
      .first<{ rev: number; size: number; ciphertext: string }>();

    const serverRev = existing?.rev ?? 0;
    const clientBase = record.baseRev ?? 0;
    let nextRev = clientBase + 1;

    if (existing && clientBase !== serverRev) {
      nextRev = Math.max(serverRev, clientBase) + 1;
      const inline = existing.size <= CONFLICT_INLINE_BYTES;
      conflicts.push({
        kind: record.kind,
        id: record.id,
        serverRev,
        ...(inline ? { serverCiphertext: existing.ciphertext } : {}),
      });
    }

    const delta = size - (existing?.size ?? 0);
    if (delta > 0) {
      const quota = await consumeQuota(env, userId, delta);
      if (!quota.allowed) {
        return fail(413, 'quota_exceeded', '雲端空間已滿', { used: quota.used, limit: quota.limit });
      }
      addedBytes += delta;
    }

    await env.DB.prepare(
      'INSERT INTO records (user_id, kind, id, rev, updated_at, size, ciphertext, blob_ref) VALUES (?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(user_id, kind, id) DO UPDATE SET rev = excluded.rev, updated_at = excluded.updated_at, size = excluded.size, ciphertext = excluded.ciphertext, blob_ref = excluded.blob_ref',
    )
      .bind(userId, record.kind, record.id, nextRev, record.updatedAt ?? now, size, record.ciphertext, record.blobRef ?? null)
      .run();

    await env.DB.prepare('INSERT INTO changes (user_id, kind, id, deleted, at) VALUES (?,?,?,0,?)')
      .bind(userId, record.kind, record.id, now)
      .run();

    accepted.push({ kind: record.kind, id: record.id, rev: nextRev });
  }

  const user = await env.DB.prepare('SELECT used_bytes, quota_bytes FROM users WHERE id = ?')
    .bind(userId)
    .first<{ used_bytes: number; quota_bytes: number }>();

  return ok({
    accepted,
    conflicts,
    quota: { used: user?.used_bytes ?? 0, limit: user?.quota_bytes ?? 0 },
    addedBytes,
  });
}
```

> `fail` 的第四個參數（extra）在 `http.ts` 尚未支援，**這一步順便把 `fail` 改成接受額外欄位**：

```ts
export function fail(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ApiReply {
  return { status, body: { ok: false, code, message, ...extra } };
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npx vitest run worker/test/sync.test.ts`
Expected: PASS（11 個用例）

- [ ] **Step 6: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add worker/src/sync.ts worker/src/http.ts worker/test/helpers/env.ts worker/test/sync.test.ts
git commit -m "feat(worker): 增量 pull 游標、push 的 LWW 衝突回報與配額"
```

---

## Task 11: 路由、CORS、管理端邀請碼與 `index.ts`

**Files:**
- Create: `worker/src/router.ts`
- Create: `worker/src/index.ts`
- Create: `worker/scripts/mint-invite.mjs`
- Create: `worker/test/router.test.ts`
- Modify: `worker/src/auth.ts`（加 `handleCreateInvite`）

**Interfaces:**
- Consumes: 全部前面的 worker 模組
- Produces:
  - `router.ts`：`route(request: Request, env: Env, now?: number): Promise<Response>`、`corsHeaders(env: Env, origin: string | null): Record<string, string>`
  - `auth.ts` 追加：`handleCreateInvite(env: Env, adminSecret: string | null, body: unknown): Promise<ApiReply>`
  - `index.ts`：`export default { fetch(request: Request, env: Env): Promise<Response> }`
  - `scripts/mint-invite.mjs`：本機產生邀請碼並印出 SQL

- [ ] **Step 1: 寫失敗的測試**

`worker/test/router.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestEnv } from './helpers/env';
import { route } from '../src/router';
import { sha256Hex } from '../src/http';

const migration = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');
const ORIGIN = 'https://air-roleplay.pages.dev';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('router', () => {
  it('OPTIONS 預檢回 204 並帶正確 CORS 標頭', async () => {
    const env = makeTestEnv(migration);
    const res = await route(new Request('https://api.example.com/api/auth/login', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('不在白名單的來源拿不到 CORS 標頭', async () => {
    const env = makeTestEnv(migration);
    const res = await route(new Request('https://api.example.com/api/me', { headers: { origin: 'https://evil.example' } }), env);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('未帶 token 的 /api/sync/pull 回 401', async () => {
    const env = makeTestEnv(migration);
    const res = await route(new Request('https://api.example.com/api/sync/pull?cursor=0'), env);
    expect(res.status).toBe(401);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('unauthorized');
  });

  it('未知路徑回 404，方法不符回 405', async () => {
    const env = makeTestEnv(migration);
    expect((await route(new Request('https://api.example.com/api/nope'), env)).status).toBe(404);
    expect((await route(new Request('https://api.example.com/api/auth/login'), env)).status).toBe(405);
  });

  it('管理端邀請碼：錯的 secret 回 401，對的 secret 產生可用的碼', async () => {
    const env = makeTestEnv(migration);
    const denied = await route(post('/api/admin/invites', { note: 'alice' }, { 'x-admin-secret': 'wrong' }), env);
    expect(denied.status).toBe(401);

    const created = await route(post('/api/admin/invites', { note: 'alice' }, { 'x-admin-secret': 'test-secret' }), env);
    expect(created.status).toBe(200);
    const body = await created.json() as { code: string };
    expect(body.code).toMatch(/^INV-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const invite = await env.DB.prepare('SELECT code_hash, note FROM invites').first<{ code_hash: string; note: string }>();
    expect(invite?.code_hash).toBe(await sha256Hex(body.code));
    expect(invite?.note).toBe('alice');
  });

  it('完整註冊流程走 HTTP 也通', async () => {
    const env = makeTestEnv(migration);
    const created = await route(post('/api/admin/invites', {}, { 'x-admin-secret': 'test-secret' }), env);
    const { code } = await created.json() as { code: string };
    const res = await route(post('/api/auth/register', {
      username: 'alice', inviteCode: code, authKey: 'k', kdf: '{}',
      wrappedDek: 'w', recoveryAuthKey: 'ra', recoveryWrappedDek: 'rw',
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { accessToken: string };
    expect(typeof body.accessToken).toBe('string');

    const me = await route(new Request('https://api.example.com/api/me', {
      headers: { authorization: `Bearer ${body.accessToken}` },
    }), env);
    expect(me.status).toBe(200);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run worker/test/router.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/router"`

- [ ] **Step 3: 在 `auth.ts` 追加 `handleCreateInvite`**

```ts
export async function handleCreateInvite(
  env: Env,
  adminSecret: string | null,
  body: unknown,
): Promise<ApiReply> {
  if (!adminSecret || adminSecret !== env.ADMIN_SECRET) {
    return fail(401, 'unauthorized', '請先登入');
  }
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const note = typeof input.note === 'string' ? input.note : null;
  const ttlDays = typeof input.ttlDays === 'number' ? input.ttlDays : null;
  const now = Date.now();

  const raw = randomToken(9).replace(/[^A-Za-z0-9]/g, '').toUpperCase().padEnd(12, 'X').slice(0, 12);
  const code = `INV-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;

  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex(code), note, now, ttlDays === null ? null : now + ttlDays * 86400000)
    .run();

  return ok({ code, note, expiresAt: ttlDays === null ? null : now + ttlDays * 86400000 });
}
```

- [ ] **Step 4: 實作 `router.ts`**

```ts
import {
  handleLogin, handleLogout, handleMe, handleRefresh, handleRegister, handleCreateInvite, authenticate,
} from './auth';
import { fail, type ApiReply } from './http';
import { handlePull, handlePush } from './sync';
import type { Env } from './types';

export function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-admin-secret',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function toResponse(reply: ApiReply, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function route(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders(env, request.headers.get('origin'));
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/admin/invites') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleCreateInvite(env, request.headers.get('x-admin-secret'), await readJson(request)), cors);
  }

  if (path === '/api/auth/register') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleRegister(env, await readJson(request), now, ip), cors);
  }

  if (path === '/api/auth/login') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleLogin(env, await readJson(request), now, ip), cors);
  }

  if (path === '/api/auth/refresh') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleRefresh(env, await readJson(request), now), cors);
  }

  const auth = await authenticate(env, request.headers.get('authorization'), now);
  if (!auth) return toResponse(fail(401, 'unauthorized', '請先登入'), cors);

  if (path === '/api/auth/logout' && method === 'POST') return toResponse(await handleLogout(env, auth.sessionId), cors);
  if (path === '/api/me' && method === 'GET') return toResponse(await handleMe(env, auth.sessionId), cors);

  if (path === '/api/sync/pull' && method === 'GET') {
    const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const limit = Number(url.searchParams.get('limit') ?? '200') || 200;
    return toResponse(await handlePull(env, auth.userId, cursor, limit), cors);
  }

  if (path === '/api/sync/push' && method === 'POST') {
    return toResponse(await handlePush(env, auth.userId, await readJson(request), now), cors);
  }

  if (path.startsWith('/api/')) return toResponse(fail(404, 'not_found', '找不到端點'), cors);
  return toResponse(fail(404, 'not_found', '找不到端點'), cors);
}
```

- [ ] **Step 5: 實作 `index.ts`**

```ts
import { route } from './router';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      return new Response(JSON.stringify({ ok: false, code: 'internal', message }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
```

- [ ] **Step 6: 寫 `scripts/mint-invite.mjs`**

```js
#!/usr/bin/env node
// 用法：node worker/scripts/mint-invite.mjs "給 alice" [有效天數]
// 產生的 SQL 直接用 wrangler d1 execute 跑，明文碼只印一次、不進資料庫。
import { createHash, randomBytes } from 'node:crypto';

const note = process.argv[2] ?? '';
const ttlDays = process.argv[3] ? Number(process.argv[3]) : null;

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const raw = Array.from(randomBytes(12), (b) => alphabet[b % 36]).join('');
const code = `INV-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
const codeHash = createHash('sha256').update(code).digest('hex');
const now = Date.now();
const expiresAt = ttlDays === null ? 'NULL' : String(now + ttlDays * 86400000);

console.log(`邀請碼（只顯示這一次）：${code}`);
console.log('');
console.log('跑這行寫進 D1：');
console.log(
  `npx wrangler d1 execute dsh-sync --remote --config worker/wrangler.jsonc --command ` +
    `"INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES ('${codeHash}', '${note.replace(/'/g, "''")}', ${now}, ${expiresAt}, NULL, NULL);"`,
);
```

- [ ] **Step 7: 執行測試確認通過**

Run: `npx vitest run worker/test/router.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 8: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add worker/src/router.ts worker/src/index.ts worker/src/auth.ts worker/scripts/mint-invite.mjs worker/test/router.test.ts
git commit -m "feat(worker): 路由、CORS 白名單、管理端邀請碼與 fetch 入口"
```

---

## Task 12: 前端 HTTP 客戶端（`client.ts`）

**Files:**
- Create: `src/core/sync/client.ts`
- Create: `src/core/sync/client.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`（`utf8`、`toBase64Url`、`fromBase64Url`）
- Produces:
  - `interface Tokens { accessToken: string; refreshToken: string }`
  - `interface PulledRecord { kind: string; id: string; deleted: boolean; rev?: number; updatedAt?: number; size?: number; ciphertext?: string; blobRef?: string }`
  - `interface PullResult { cursor: number; hasMore: boolean; records: PulledRecord[]; quota: { used: number; limit: number } }`
  - `interface PushPayload { records: Array<{ kind: string; id: string; rev: number; baseRev: number; updatedAt: number; deleted?: boolean; size: number; ciphertext?: string; blobRef?: string }> }`
  - `interface PushResult { accepted: Array<{ kind: string; id: string; rev: number }>; conflicts: Array<{ kind: string; id: string; serverRev: number; serverCiphertext?: string }>; quota: { used: number; limit: number } }`
  - `class SyncApiError extends Error { status: number; code: string }`
  - `createSyncClient(opts: { baseUrl: string; fetchImpl?: typeof fetch; getTokens?: () => Tokens | null; onTokens?: (t: Tokens | null) => void }): SyncClient`
  - `interface SyncClient { register(...): Promise<{ username: string } & Tokens>; login(...): Promise<{ username: string } & Tokens>; logout(): Promise<void>; me(): Promise<{ username: string; quota: { used: number; limit: number } }>; pull(cursor: number, limit?: number): Promise<PullResult>; push(payload: PushPayload): Promise<PushResult> }`

- [ ] **Step 1: 寫失敗的測試（用假的 fetch，不打真網路）**

`src/core/sync/client.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { createSyncClient, SyncApiError } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('sync client', () => {
  it('登入成功後把 token 交出去', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, username: 'alice', accessToken: 'A1', refreshToken: 'R1' }));
    const seen: unknown[] = [];
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, onTokens: (t) => seen.push(t) });
    const out = await client.login({ username: 'alice', authKey: 'k' });
    expect(out.username).toBe('alice');
    expect(seen).toEqual([{ accessToken: 'A1', refreshToken: 'R1' }]);
  });

  it('帶 token 的請求會附 Authorization', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(200, { ok: true, cursor: 0, hasMore: false, records: [], quota: { used: 0, limit: 1 } });
    }) as unknown as typeof fetch;
    const client = createSyncClient({ baseUrl: 'https://api.test/', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    await client.pull(0);
    expect(calls[0].url).toBe('https://api.test/api/sync/pull?cursor=0&limit=200');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer A1');
  });

  it('401 會自動 refresh 並重試一次', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return jsonResponse(200, { ok: true, accessToken: 'A2', refreshToken: 'R2' });
      attempt += 1;
      if (attempt === 1) return jsonResponse(401, { ok: false, code: 'unauthorized', message: '請先登入' });
      return jsonResponse(200, { ok: true, cursor: 5, hasMore: false, records: [], quota: { used: 0, limit: 1 } });
    }) as unknown as typeof fetch;
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    const out = await client.pull(0);
    expect(out.cursor).toBe(5);
    expect(attempt).toBe(2);
  });

  it('refresh 也失敗就拋 401，並清掉 token', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/api/auth/refresh')
        ? jsonResponse(401, { ok: false, code: 'bad_refresh', message: '登入狀態已過期' })
        : jsonResponse(401, { ok: false, code: 'unauthorized', message: '請先登入' })) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }), onTokens: (t) => seen.push(t) });
    await expect(client.pull(0)).rejects.toBeInstanceOf(SyncApiError);
    expect(seen).toEqual([null]);
  });

  it('伺服器錯誤會被包成 SyncApiError（帶 code 與 status）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(413, { ok: false, code: 'quota_exceeded', message: '雲端空間已滿', used: 9, limit: 10 })) as unknown as typeof fetch;
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    await expect(client.push({ records: [] })).rejects.toMatchObject({ status: 413, code: 'quota_exceeded' });
  });

  it('網路錯誤原樣往上拋（讓引擎決定要不要退避）', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl, getTokens: () => ({ accessToken: 'A1', refreshToken: 'R1' }) });
    await expect(client.pull(0)).rejects.toBeInstanceOf(TypeError);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/core/sync/client.test.ts`
Expected: FAIL —— `Failed to resolve import "./client"`

- [ ] **Step 3: 實作 `client.ts`**

```ts
export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface PulledRecord {
  kind: string;
  id: string;
  deleted: boolean;
  rev?: number;
  updatedAt?: number;
  size?: number;
  ciphertext?: string;
  blobRef?: string;
}

export interface PullResult {
  cursor: number;
  hasMore: boolean;
  records: PulledRecord[];
  quota: { used: number; limit: number };
}

export interface PushPayload {
  records: Array<{
    kind: string;
    id: string;
    rev: number;
    baseRev: number;
    updatedAt: number;
    deleted?: boolean;
    size: number;
    ciphertext?: string;
    blobRef?: string;
  }>;
}

export interface PushResult {
  accepted: Array<{ kind: string; id: string; rev: number }>;
  conflicts: Array<{ kind: string; id: string; serverRev: number; serverCiphertext?: string }>;
  quota: { used: number; limit: number };
}

export class SyncApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'SyncApiError';
  }
}

export interface SyncClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getTokens?: () => Tokens | null;
  onTokens?: (tokens: Tokens | null) => void;
}

export interface SyncClient {
  register(input: {
    username: string; inviteCode: string; authKey: string; kdf: string;
    wrappedDek: string; recoveryAuthKey: string; recoveryWrappedDek: string; label?: string;
  }): Promise<{ username: string } & Tokens>;
  login(input: { username: string; authKey: string; label?: string }): Promise<{ username: string } & Tokens>;
  logout(): Promise<void>;
  me(): Promise<{ username: string; createdAt: number; quota: { used: number; limit: number } }>;
  pull(cursor: number, limit?: number): Promise<PullResult>;
  push(payload: PushPayload): Promise<PushResult>;
}

export function createSyncClient(opts: SyncClientOptions): SyncClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let tokens: Tokens | null = opts.getTokens?.() ?? null;

  function setTokens(next: Tokens | null): void {
    tokens = next;
    opts.onTokens?.(next);
  }

  async function raw(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.auth !== false && tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
    const response = await doFetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new SyncApiError(
        response.status,
        typeof parsed.code === 'string' ? parsed.code : 'http_error',
        typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`,
      );
    }
    return parsed;
  }

  async function refresh(): Promise<boolean> {
    if (!tokens) return false;
    try {
      const out = (await raw('/api/auth/refresh', { method: 'POST', body: { refreshToken: tokens.refreshToken }, auth: false })) as {
        accessToken: string;
        refreshToken: string;
      };
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return true;
    } catch {
      setTokens(null);
      return false;
    }
  }

  async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    try {
      return (await raw(path, init)) as T;
    } catch (err) {
      if (err instanceof SyncApiError && err.status === 401 && init.auth !== false && (await refresh())) {
        return (await raw(path, init)) as T;
      }
      throw err;
    }
  }

  return {
    async register(input) {
      const out = await call<{ username: string; accessToken: string; refreshToken: string }>('/api/auth/register', {
        method: 'POST',
        body: input,
        auth: false,
      });
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return out;
    },
    async login(input) {
      const out = await call<{ username: string; accessToken: string; refreshToken: string }>('/api/auth/login', {
        method: 'POST',
        body: input,
        auth: false,
      });
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return out;
    },
    async logout() {
      try {
        await call('/api/auth/logout', { method: 'POST' });
      } finally {
        setTokens(null);
      }
    },
    async me() {
      return call<{ username: string; createdAt: number; quota: { used: number; limit: number } }>('/api/me');
    },
    async pull(cursor, limit = 200) {
      return call<PullResult>(`/api/sync/pull?cursor=${cursor}&limit=${limit}`);
    },
    async push(payload) {
      return call<PushResult>('/api/sync/push', { method: 'POST', body: payload });
    },
  };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/client.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/client.ts src/core/sync/client.test.ts
git commit -m "feat(sync): HTTP 客戶端（401 自動 refresh、錯誤帶 code）"
```

---

## Task 13: 同步引擎 —— 推送（`engine.ts`）

**Files:**
- Create: `src/core/sync/engine.ts`
- Create: `src/core/sync/engine-push.test.ts`
- Create: `src/test/fake-server.ts`（把 Task 10/11 的 worker handler 接成 `fetch` 形狀，測試用）

**Interfaces:**
- Consumes: `outbox.ts`、`kinds.ts`、`envelope.ts`、`client.ts`、`storage/db.ts`
- Produces:
  - `src/test/fake-server.ts`：`makeFakeServer(env: Env): typeof fetch`、`makeWorkerEnv(seedSql: string): Env`
  - `engine.ts`：
    - `interface EngineContext { db: DshDB; client: SyncClient; dek: CryptoKey; deviceId: string }`
    - `getSyncState(ctx): Promise<{ cursor: number; deviceId: string }>`
    - `pushPending(ctx, opts?: { batch?: number }): Promise<{ pushed: number; conflicts: number }>`
    - `readRowForSync(ctx, kind: SyncKind, id: string): Promise<Record<string, unknown> | null>`

- [ ] **Step 1: 寫測試用的假伺服器**

`src/test/fake-server.ts`：

```ts
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { route } from '../../worker/src/router';
import { makeTestEnv } from '../../worker/test/helpers/env';
import type { Env } from '../../worker/src/types';

export function makeWorkerEnv(): Env {
  const migration = readFileSync(join(__dirname, '..', '..', 'worker', 'migrations', '0001_init.sql'), 'utf8');
  return makeTestEnv(migration);
}

export function makeFakeServer(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    return route(request, env);
  }) as typeof fetch;
}
```

- [ ] **Step 2: 寫失敗的測試**

`src/core/sync/engine-push.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestD1 } from '../../worker/test/helpers/d1';
import { sha256Hex } from '../../worker/src/http';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv } from '../../test/fake-server';
import { switchDatabase, type DshDB } from '../storage/db';
import { installSyncTap, setApplyingRemote, pendingCount } from './outbox';
import { pushPending } from './engine';
import { deriveAuthKey, deriveMasterKey, generateRecoveryCode, deriveRecoveryAuthKey, TEST_KDF } from './kdf';
import { generateDek, wrapDek, unwrapDek, decryptEnvelope } from './envelope';

const ORIGIN = 'https://air-roleplay.pages.dev';

async function freshDevice(name: string): Promise<DshDB> {
  const d = await switchDatabase(name);
  installSyncTap(d);
  return d;
}

async function setupAccount() {
  const env = makeWorkerEnv();
  const server = makeFakeServer(env);
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex('INV-TEST'), null, 1, null).run();

  const dek = await generateDek();
  const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
  const wrappedDek = await wrapDek(dek, master);
  const recoveryCode = generateRecoveryCode();

  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice',
    inviteCode: 'INV-TEST',
    authKey: await deriveAuthKey('pw-123', 'alice', TEST_KDF),
    kdf: JSON.stringify(TEST_KDF),
    wrappedDek,
    recoveryAuthKey: await deriveRecoveryAuthKey(recoveryCode, 'alice'),
    recoveryWrappedDek: wrappedDek,
    label: 'test',
  });
  return { env, server, client, dek, wrappedDek, recoveryCode };
}

describe('engine push', () => {
  it('本地未登入的資料也能進 outbox（不影響既有行為）', async () => {
    const db = await freshDevice(`push-a-${Math.random().toString(36).slice(2)}`);
    await db.settings.put({ key: 'fontSize', value: '18' });
    expect(await pendingCount(db)).toBe(1);
  });

  it('pushPending 之後雲端有密文、本地 outbox 清空、__rev 記回來', async () => {
    const { env, server, client, dek } = await setupAccount();
    const db = await freshDevice(`push-b-${Math.random().toString(36).slice(2)}`);
    await db.settings.put({ key: 'fontSize', value: '18' });

    const ctx = { db, client, dek, deviceId: 'dev_a' };
    const out = await pushPending(ctx);
    expect(out).toEqual({ pushed: 1, conflicts: 0 });

    const stored = await env.DB.prepare("SELECT ciphertext, rev, size FROM records WHERE kind = 'setting'").first<{ ciphertext: string; rev: number; size: number }>();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain('fontSize');
    expect(stored?.rev).toBe(1);

    const local = await db.settings.get('fontSize');
    expect((local as Record<string, unknown>).__rev).toBe(1);
    expect(await pendingCount(db)).toBe(0);
  });

  it('刪除會送墓碑，雲端記錄消失', async () => {
    const { env, server, client, dek } = await setupAccount();
    const db = await freshDevice(`push-c-${Math.random().toString(36).slice(2)}`);
    await db.settings.put({ key: 'tmp', value: '1' });
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    await pushPending(ctx);
    await db.settings.delete('tmp');
    await pushPending(ctx);
    const row = await env.DB.prepare("SELECT rev FROM records WHERE kind = 'setting' AND id = 'tmp'").first();
    expect(row).toBeNull();
  });

  it('provider 的秘密欄位永遠不會上傳', async () => {
    const { env, server, client, dek } = await setupAccount();
    const db = await freshDevice(`push-d-${Math.random().toString(36).slice(2)}`);
    await db.providers.put({
      id: 'prov_1', label: '中轉', protocol: 'openai', baseUrl: 'https://api.example',
      apiKey: 'sk-super-secret', extraHeaders: { Authorization: 'Bearer super-secret' }, createdAt: 1,
    });
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    await pushPending(ctx);
    const rows = await env.DB.prepare("SELECT ciphertext FROM records WHERE kind = 'provider'").all<{ ciphertext: string }>();
    const all = JSON.stringify(rows.results);
    expect(all).not.toContain('sk-super-secret');
    expect(all).not.toContain('super-secret');
  });

  it('同裝置連續兩次編輯：rev 遞增、不算衝突', async () => {
    const { env, server, client, dek } = await setupAccount();
    const db = await freshDevice(`push-f-${Math.random().toString(36).slice(2)}`);
    const ctx = { db, client, dek, deviceId: 'dev_a' };
    await db.settings.put({ key: 'k', value: 'v1' });
    expect(await pushPending(ctx)).toEqual({ pushed: 1, conflicts: 0 });
    await db.settings.put({ key: 'k', value: 'v2' });
    expect(await pushPending(ctx)).toEqual({ pushed: 1, conflicts: 0 });
    const row = await env.DB.prepare("SELECT rev FROM records WHERE kind = 'setting'").first<{ rev: number }>();
    expect(row?.rev).toBe(2);
    expect((await db.settings.get('k'))?.__rev).toBe(2);
  });

  it('落後的 baseRev 會回報衝突，並把被覆蓋的版本存進 syncConflicts', async () => {
    const { server, client, dek } = await setupAccount();
    const dbA = await freshDevice(`push-g1-${Math.random().toString(36).slice(2)}`);
    const dbB = await freshDevice(`push-g2-${Math.random().toString(36).slice(2)}`);

    // A 建立並推送 → 雲端 rev 1
    await dbA.settings.put({ key: 'k', value: 'v1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    // B 拉到 rev 1（__rev 由拉取寫入；這裡直接沿用 A 的內容當作 B 的本地狀態）
    setApplyingRemote(true);
    await dbB.settings.put({ ...(await dbA.settings.get('k')), value: 'v1' });
    setApplyingRemote(false);
    expect((await dbB.settings.get('k'))?.__rev).toBe(1);

    // A 又改一次並推送 → 雲端 rev 2
    await dbA.settings.put({ key: 'k', value: 'v2' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    // B 用過期的 baseRev=1 推送 → 衝突
    await dbB.settings.put({ key: 'k', value: 'v3' });
    const out = await pushPending({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(out.pushed).toBe(1);
    expect(out.conflicts).toBe(1);

    // 被覆蓋的 A 版本（v2）留在 B 的 syncConflicts 裡，而且解得出原文
    const stored = await dbB.syncConflicts.toArray();
    expect(stored).toHaveLength(1);
    const decoded = await decryptEnvelope<{ value: string }>(dek, stored[0].kind, stored[0].id, stored[0].ciphertext);
    expect(decoded.data.value).toBe('v2');

    // LWW：雲端最終是 B 的 v3，rev 3
    expect((await dbB.settings.get('k'))?.__rev).toBe(3);
  });
});
```

> 這兩條是同步層的核心價值測試：**同裝置連續編輯不該誤報衝突**，**落後的裝置編輯不該靜默吃掉別人的版本**（要留副本）。

- [ ] **Step 3: 執行確認失敗**

Run: `npx vitest run src/core/sync/engine-push.test.ts`
Expected: FAIL —— `Failed to resolve import "./engine"`

- [ ] **Step 4: 實作 `engine.ts`（本任務只到 push）**

```ts
import type { DshDB } from '../storage/db';
import { decryptEnvelope, encryptEnvelope, type Envelope } from './envelope';
import { SYNC_TABLES, sanitizeForSync, type SyncKind } from './kinds';
import { clearOutbox, setApplyingRemote, takeOutbox } from './outbox';
import type { SyncClient } from './client';

export interface EngineContext {
  db: DshDB;
  client: SyncClient;
  dek: CryptoKey;
  deviceId: string;
}

export const PUSH_BATCH = 20;

export async function getSyncState(ctx: EngineContext): Promise<{ cursor: number; deviceId: string }> {
  const stored = await ctx.db.syncState.get('deviceId');
  if (!stored) await ctx.db.syncState.put({ key: 'deviceId', value: ctx.deviceId });
  const cursor = await ctx.db.syncState.get('cursor');
  return { cursor: Number(cursor?.value ?? 0), deviceId: ctx.deviceId };
}

export async function readRowForSync(
  db: DshDB,
  kind: SyncKind,
  id: string,
): Promise<Record<string, unknown> | null> {
  const table = db.table(SYNC_TABLES[kind]);
  if (kind === 'cardFile' || kind === 'cardUiState') {
    const at = id.indexOf(':');
    const primary = id.slice(0, at);
    const secondary = id.slice(at + 1);
    const row = await table.get([primary, secondary]);
    return (row as Record<string, unknown>) ?? null;
  }
  const row = await table.get(id);
  return (row as Record<string, unknown>) ?? null;
}

async function stampRev(ctx: EngineContext, kind: SyncKind, id: string, rev: number): Promise<void> {
  const row = await readRowForSync(ctx.db, kind, id);
  if (!row) return;
  setApplyingRemote(true);
  try {
    const table = ctx.db.table(SYNC_TABLES[kind]);
    await table.put({ ...row, __rev: rev });
  } finally {
    setApplyingRemote(false);
  }
}

export async function pushPending(
  ctx: EngineContext,
  opts: { batch?: number } = {},
): Promise<{ pushed: number; conflicts: number }> {
  const entries = await takeOutbox(opts.batch ?? PUSH_BATCH, ctx.db);
  if (entries.length === 0) return { pushed: 0, conflicts: 0 };

  const payloadRecords: Array<Record<string, unknown>> = [];
  const sent: typeof entries = [];

  for (const entry of entries) {
    if (entry.deleted === 1) {
      payloadRecords.push({
        kind: entry.kind,
        id: entry.id,
        rev: 0,
        baseRev: 0,
        updatedAt: Date.now(),
        deleted: true,
        size: 0,
      });
      sent.push(entry);
      continue;
    }
    const row = await readRowForSync(ctx.db, entry.kind, entry.id);
    if (!row) {
      // 本地已經沒有這筆（先建後刪）→ 直接送墓碑，不必再推內容
      payloadRecords.push({
        kind: entry.kind,
        id: entry.id,
        rev: 0,
        baseRev: 0,
        updatedAt: Date.now(),
        deleted: true,
        size: 0,
      });
      sent.push(entry);
      continue;
    }
    const baseRev = Number(row.__rev ?? 0);
    const rev = baseRev + 1;
    const envelope: Envelope = {
      v: 1,
      rev,
      updatedAt: Date.now(),
      deviceId: ctx.deviceId,
      data: sanitizeForSync(entry.kind, row),
    };
    const ciphertext = await encryptEnvelope(ctx.dek, entry.kind, entry.id, envelope);
    payloadRecords.push({
      kind: entry.kind,
      id: entry.id,
      rev,
      baseRev,
      updatedAt: envelope.updatedAt,
      size: ciphertext.length,
      ciphertext,
    });
    sent.push(entry);
  }

  const result = await ctx.client.push({ records: payloadRecords as never });

  const revByKey = new Map(result.accepted.map((a) => [`${a.kind}|${a.id}`, a.rev]));
  for (const entry of sent) {
    const rev = revByKey.get(`${entry.kind}|${entry.id}`);
    if (rev !== undefined && entry.deleted === 0) await stampRev(ctx, entry.kind, entry.id, rev);
  }

  for (const conflict of result.conflicts) {
    if (!conflict.serverCiphertext) continue;
    try {
      const decoded = await decryptEnvelope(ctx.dek, conflict.kind, conflict.id, conflict.serverCiphertext);
      await ctx.db.syncConflicts.add({
        kind: conflict.kind,
        id: conflict.id,
        rev: conflict.serverRev,
        updatedAt: decoded.updatedAt,
        ciphertext: conflict.serverCiphertext,
        detectedAt: Date.now(),
      });
    } catch {
      // 解不開的衝突版本直接跳過：不讓一個壞信封卡住整批同步
    }
  }

  await clearOutbox(sent, ctx.db);
  await ctx.db.syncState.put({ key: 'lastPushAt', value: String(Date.now()) });
  return { pushed: sent.length, conflicts: result.conflicts.length };
}
```

- [ ] **Step 5: 執行測試確認通過**

Run: `npx vitest run src/core/sync/engine-push.test.ts`
Expected: PASS（6 個用例）

- [ ] **Step 6: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/engine.ts src/core/sync/engine-push.test.ts src/test/fake-server.ts
git commit -m "feat(sync): 推送引擎（rev 記回、衝突副本、墓碑、秘密欄位不外流）"
```

---

## Task 14: 同步引擎 —— 拉取、首次全量與 `syncNow`

**Files:**
- Modify: `src/core/sync/engine.ts`
- Create: `src/core/sync/engine-pull.test.ts`

**Interfaces:**
- Consumes: Task 13 的 `EngineContext`、`pushPending`、`readRowForSync`
- Produces（`engine.ts` 追加）：
  - `applyRemoteRecord(ctx, record: PulledRecord): Promise<'applied' | 'deleted' | 'skipped'>`
  - `pullChanges(ctx, opts?: { maxPages?: number }): Promise<{ applied: number; cursor: number }>`
  - `initialPush(ctx, onProgress?: (done: number, total: number) => void): Promise<{ pushed: number }>`
  - `syncNow(ctx): Promise<{ pushed: number; conflicts: number; applied: number; cursor: number }>`

- [ ] **Step 1: 寫失敗的測試**

`src/core/sync/engine-pull.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../worker/src/http';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv } from '../../test/fake-server';
import { switchDatabase, type DshDB } from '../storage/db';
import { installSyncTap, setApplyingRemote } from './outbox';
import { pushPending, pullChanges, syncNow, initialPush } from './engine';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);

async function device(name: string): Promise<DshDB> {
  const d = await switchDatabase(name);
  installSyncTap(d);
  return d;
}

async function account() {
  const env = makeWorkerEnv();
  const server = makeFakeServer(env);
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex('INV-1'), null, 1, null).run();

  const dek = await generateDek();
  const master = await deriveMasterKey('pw', 'alice', TEST_KDF);
  const recovery = generateRecoveryCode();
  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice', inviteCode: 'INV-1',
    authKey: await deriveAuthKey('pw', 'alice', TEST_KDF), kdf: JSON.stringify(TEST_KDF),
    wrappedDek: await wrapDek(dek, master),
    recoveryAuthKey: await deriveRecoveryAuthKey(recovery, 'alice'),
    recoveryWrappedDek: await wrapDek(dek, master), label: 'a',
  });
  return { env, server, client, dek };
}

describe('engine pull / syncNow', () => {
  it('A 推、B 拉 → B 拿到解密後的一致資料', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-a-${rnd()}`);
    const dbB = await device(`pull-b-${rnd()}`);

    await dbA.settings.put({ key: 'theme', value: 'dark' });
    await dbA.chats.put({
      id: 'chat_1', cardId: 'card_1', title: '第一次約會', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    const out = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(out.applied).toBe(2);
    expect((await dbB.settings.get('theme'))?.value).toBe('dark');
    expect((await dbB.chats.get('chat_1'))?.title).toBe('第一次約會');
  });

  it('B 拉到的資料不會被當成本地變更再推回去（不迴圈）', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-c-${rnd()}`);
    const dbB = await device(`pull-d-${rnd()}`);
    await dbA.settings.put({ key: 'k', value: 'v' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });

    const { pendingCount } = await import('./outbox');
    expect(await pendingCount(dbB)).toBe(0);
    await dbB.settings.put({ key: 'k2', value: 'v2' });
    expect(await pendingCount(dbB)).toBe(1);
  });

  it('游標增量：第二次拉取不會重覆套用', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-e-${rnd()}`);
    const dbB = await device(`pull-f-${rnd()}`);
    await dbA.settings.put({ key: 'a', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    const first = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    const second = await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });

  it('墓碑會刪掉本地那筆', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-g-${rnd()}`);
    const dbB = await device(`pull-h-${rnd()}`);
    await dbA.settings.put({ key: 'gone', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(await dbB.settings.get('gone')).toBeTruthy();

    await dbA.settings.delete('gone');
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
    await pullChanges({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(await dbB.settings.get('gone')).toBeUndefined();
  });

  it('用錯的 DEK 拉取：不寫入任何東西，也不拋出到呼叫端以外的地方', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-i-${rnd()}`);
    const dbB = await device(`pull-j-${rnd()}`);
    await dbA.settings.put({ key: 'x', value: '1' });
    await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });

    const wrongDek = await generateDek();
    const out = await pullChanges({ db: dbB, client, dek: wrongDek, deviceId: 'dev_b' });
    expect(out.applied).toBe(0);
    expect(await dbB.settings.get('x')).toBeUndefined();
  });

  it('initialPush 把既有本地資料全部送上雲', async () => {
    const { env, server, client, dek } = await account();
    const db = await device(`pull-k-${rnd()}`);
    await db.settings.put({ key: 's1', value: '1' });
    await db.chats.put({
      id: 'chat_9', cardId: 'c', title: 't', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    const out = await initialPush({ db, client, dek, deviceId: 'dev_a' });
    expect(out.pushed).toBe(2);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('syncNow 一次跑完推送與拉取', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`pull-l-${rnd()}`);
    const dbB = await device(`pull-m-${rnd()}`);
    await dbA.settings.put({ key: 'live', value: 'yes' });
    const a = await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    expect(a.pushed).toBe(1);
    const b = await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect(b.applied).toBe(1);
    expect((await dbB.settings.get('live'))?.value).toBe('yes');
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/core/sync/engine-pull.test.ts`
Expected: FAIL —— `pullChanges is not a function`

- [ ] **Step 3: 在 `engine.ts` 追加實作**

```ts
// engine.ts 檔頭那兩行 import 改成這樣（Task 13 已經有 SyncClient，這裡補 PulledRecord 與 keyOf）：
import type { PulledRecord, SyncClient } from './client';
import { keyOf, SYNC_TABLES, sanitizeForSync, type SyncKind } from './kinds';

export async function applyRemoteRecord(
  ctx: EngineContext,
  record: PulledRecord,
): Promise<'applied' | 'deleted' | 'skipped'> {
  const table = ctx.db.table(SYNC_TABLES[record.kind as SyncKind]);
  if (!table) return 'skipped';

  if (record.deleted) {
    setApplyingRemote(true);
    try {
      if ((record.kind === 'cardFile' || record.kind === 'cardUiState')) {
        const at = record.id.indexOf(':');
        await table.delete([record.id.slice(0, at), record.id.slice(at + 1)]);
      } else {
        await table.delete(record.id);
      }
    } finally {
      setApplyingRemote(false);
    }
    return 'deleted';
  }

  if (!record.ciphertext) return 'skipped';
  let envelope: Envelope<Record<string, unknown>>;
  try {
    envelope = await decryptEnvelope<Record<string, unknown>>(ctx.dek, record.kind, record.id, record.ciphertext);
  } catch {
    // 解不開（別的帳號的庫、或金鑰不符）：整批跳過，讓 UI 去顯示「資料屬於其他帳號」
    return 'skipped';
  }

  const row: Record<string, unknown> = { ...envelope.data, __rev: record.rev ?? envelope.rev };
  setApplyingRemote(true);
  try {
    await table.put(row);
  } finally {
    setApplyingRemote(false);
  }

  if (record.blobRef) {
    await ctx.db.blobState.put({
      blobId: record.blobRef,
      state: 'remote',
      refId: record.id,
      size: record.size ?? 0,
    });
  }
  return 'applied';
}

export async function pullChanges(
  ctx: EngineContext,
  opts: { maxPages?: number } = {},
): Promise<{ applied: number; cursor: number }> {
  const maxPages = opts.maxPages ?? 20;
  let cursor = (await getSyncState(ctx)).cursor;
  let applied = 0;

  for (let page = 0; page < maxPages; page++) {
    const result = await ctx.client.pull(cursor);
    for (const record of result.records) {
      const outcome = await applyRemoteRecord(ctx, record);
      if (outcome === 'applied') applied += 1;
    }
    cursor = result.cursor;
    await ctx.db.syncState.put({ key: 'cursor', value: String(cursor) });
    await ctx.db.syncState.put({ key: 'quotaUsed', value: String(result.quota.used) });
    await ctx.db.syncState.put({ key: 'quotaLimit', value: String(result.quota.limit) });
    if (!result.hasMore) break;
  }

  await ctx.db.syncState.put({ key: 'lastSyncAt', value: String(Date.now()) });
  return { applied, cursor };
}

export async function initialPush(
  ctx: EngineContext,
  onProgress?: (done: number, total: number) => void,
): Promise<{ pushed: number }> {
  const kinds = Object.keys(SYNC_TABLES) as SyncKind[];
  let queued = 0;
  for (const kind of kinds) {
    const table = ctx.db.table(SYNC_TABLES[kind]);
    const rows = (await table.toArray()) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    setApplyingRemote(true);
    try {
      await ctx.db.syncOutbox.bulkPut(
        rows.map((row) => ({ kind, id: keyOf(kind, row), deleted: 0 as const, queuedAt: Date.now() })),
      );
    } finally {
      setApplyingRemote(false);
    }
    queued += rows.length;
  }

  let pushed = 0;
  while (true) {
    const step = await pushPending(ctx);
    pushed += step.pushed;
    onProgress?.(pushed, queued);
    if (step.pushed === 0) break;
  }
  return { pushed };
}

export async function syncNow(ctx: EngineContext): Promise<{
  pushed: number;
  conflicts: number;
  applied: number;
  cursor: number;
}> {
  let pushed = 0;
  let conflicts = 0;
  while (true) {
    const step = await pushPending(ctx);
    pushed += step.pushed;
    conflicts += step.conflicts;
    if (step.pushed === 0) break;
  }
  const pulled = await pullChanges(ctx);
  return { pushed, conflicts, applied: pulled.applied, cursor: pulled.cursor };
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/core/sync/engine-pull.test.ts`
Expected: PASS（7 個用例）

- [ ] **Step 5: 全套測試與建置並提交**

Run: `npm run test && npm run build`

```bash
git add src/core/sync/engine.ts src/core/sync/engine-pull.test.ts
git commit -m "feat(sync): 拉取引擎、游標增量、首次全量推送與 syncNow"
```

---

## Task 15: 兩裝置整合驗收（含離線補推與秘密外流檢查）

**Files:**
- Create: `src/core/sync/integration.test.ts`
- Modify: `README.md`（補一段「同步核心已就緒」與如何跑這一組測試）

**Interfaces:**
- Consumes: 前面全部
- Produces: 無新介面；這一任務是把 spec §12 的驗收標準 2、4、7 變成自動化測試

- [ ] **Step 1: 寫測試（先把驗收標準寫成會失敗／會過的斷言）**

`src/core/sync/integration.test.ts`：

```ts
/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../../worker/src/http';
import { createSyncClient } from './client';
import { makeFakeServer, makeWorkerEnv } from '../../test/fake-server';
import { switchDatabase, type DshDB } from '../storage/db';
import { installSyncTap, pendingCount } from './outbox';
import { syncNow, pushPending } from './engine';
import { deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey, generateRecoveryCode, TEST_KDF } from './kdf';
import { generateDek, wrapDek, unwrapDek, dekFingerprint } from './envelope';

const rnd = () => Math.random().toString(36).slice(2);

async function device(name: string): Promise<DshDB> {
  const d = await switchDatabase(name);
  installSyncTap(d);
  return d;
}

async function account() {
  const env = makeWorkerEnv();
  const server = makeFakeServer(env);
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex('INV-INT'), null, 1, null).run();

  const dek = await generateDek();
  const master = await deriveMasterKey('pw-123', 'alice', TEST_KDF);
  const wrappedDek = await wrapDek(dek, master);
  const recoveryCode = generateRecoveryCode();

  const client = createSyncClient({ baseUrl: 'https://api.test', fetchImpl: server });
  await client.register({
    username: 'alice', inviteCode: 'INV-INT',
    authKey: await deriveAuthKey('pw-123', 'alice', TEST_KDF), kdf: JSON.stringify(TEST_KDF),
    wrappedDek,
    recoveryAuthKey: await deriveRecoveryAuthKey(recoveryCode, 'alice'),
    // 恢復碼用「另一把」由 recwrap 鹽衍生的金鑰包 DEK（與送伺服器的 recoveryAuthKey 無關）
    recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(recoveryCode, 'alice')),
    label: 'device-a',
  });
  return { env, server, client, dek, wrappedDek, master, recoveryCode };
}

describe('兩裝置整合（spec §12 驗收標準 2 / 4 / 7）', () => {
  it('驗收 2：A 發訊息 → B 拉到且解密可讀，訊息樹 parentId 完整', async () => {
    const { server, client, dek } = await account();
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
  });

  it('驗收 4：雲端找不到 apiKey / extraHeaders 的任何痕跡', async () => {
    const { env, server, client, dek } = await account();
    const dbA = await device(`int-c-${rnd()}`);
    await dbA.providers.put({
      id: 'prov_1', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-LEAK-CANARY-1234567890', extraHeaders: { 'x-canary': 'HEADER-CANARY' }, createdAt: 1,
    });
    await dbA.modelPresets.put({
      id: 'mp_1', providerId: 'prov_1', model: 'deepseek-chat',
      params: { temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 100, contextLength: 1000, thinkingBudget: 0 },
      capabilities: { temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true, maxTokens: true, contextLength: 1000, thinkingBudget: false, prefill: false, systemRole: true },
    });
    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });

    const rows = await env.DB.prepare('SELECT kind, ciphertext FROM records').all<{ kind: string; ciphertext: string | null }>();
    const dump = JSON.stringify(rows.results);
    // 只驗「金絲雀字串」有沒有外流。不要驗 `sk-` 這種短前綴——base64url 密文本身就可能出現，
    // 那會變成隨機失敗的假警報。
    expect(rows.results.length).toBeGreaterThan(0);
    expect(dump).not.toContain('LEAK-CANARY');
    expect(dump).not.toContain('HEADER-CANARY');
    expect(dump).not.toContain('deepseek.com'); // baseUrl 也在密文裡
    for (const row of rows.results) {
      expect(row.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    }

    // 而且解開來真的有服務商設定（只是沒有秘密）
    const dbB = await device(`int-d-${rnd()}`);
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    const provider = await dbB.providers.get('prov_1');
    expect(provider?.baseUrl).toBe('https://api.deepseek.com');
    expect(provider?.apiKey).toBeUndefined();
  });

  it('驗收 7：離線期間的變更會補推，另一台看得到', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`int-e-${rnd()}`);
    const dbB = await device(`int-f-${rnd()}`);

    // 模擬離線：這次先不呼叫 sync
    await dbA.settings.put({ key: 'offline1', value: '1' });
    await dbA.settings.put({ key: 'offline2', value: '2' });
    await dbA.settings.put({ key: 'offline3', value: '3' });
    expect(await pendingCount(dbA)).toBe(3);

    await syncNow({ db: dbA, client, dek, deviceId: 'dev_a' });
    expect(await pendingCount(dbA)).toBe(0);
    await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
    expect((await dbB.settings.get('offline3'))?.value).toBe('3');
  });

  it('wrappedDek 往返：換裝置用同一組密碼解出同一把 DEK', async () => {
    const { wrappedDek, dek, master } = await account();
    expect(await dekFingerprint(await unwrapDek(wrappedDek, master))).toBe(await dekFingerprint(dek));
    const wrongPassword = await deriveMasterKey('pw-999', 'alice', TEST_KDF);
    await expect(unwrapDek(wrappedDek, wrongPassword)).rejects.toThrow();
  });

  it('大量資料分批推送不會漏（45 筆跨 3 批）', async () => {
    const { server, client, dek } = await account();
    const dbA = await device(`int-g-${rnd()}`);
    const dbB = await device(`int-h-${rnd()}`);
    for (let i = 0; i < 45; i++) await dbA.settings.put({ key: `bulk_${i}`, value: String(i) });

    let total = 0;
    while (true) {
      const step = await pushPending({ db: dbA, client, dek, deviceId: 'dev_a' });
      total += step.pushed;
      if (step.pushed === 0) break;
    }
    expect(total).toBe(45);

    // 拉到沒有新東西為止（會跨多頁，因為 MAX_PUSH_BATCH=20）
    let applied = 0;
    for (let i = 0; i < 10; i++) {
      const pulled = await syncNow({ db: dbB, client, dek, deviceId: 'dev_b' });
      applied += pulled.applied;
      if (pulled.applied === 0 && pulled.pushed === 0) break;
    }
    expect(await dbB.settings.count()).toBe(45);
    expect(applied).toBeGreaterThanOrEqual(45);
  });
});
```

> 最後一條會跑 3 批推送與多頁拉取，是為了把 `MAX_PUSH_BATCH=20` 與 200 筆分頁的邊界壓出來。

- [ ] **Step 2: 執行整合測試**

Run: `npx vitest run src/core/sync/integration.test.ts`
Expected: 6 個用例 PASS。若有 FAIL，**先修實作**；只有當斷言本身寫錯（例如把 spec 的驗收條件寫反了）才改測試，並在 commit 訊息裡說明原因。

- [ ] **Step 3: 修 README**

在 `README.md` 的「部署到 Cloudflare Pages」之後新增一節：

```md
## 帳號與同步（核心已就緒）

帳號、邀請碼、零知識加密與同步引擎在 `src/core/sync/`，後端是獨立的 Cloudflare Worker（`worker/`）。
目前的進度與後續里程碑見 `docs/superpowers/specs/2026-10-14-account-sync-design.md`；逐步實作計畫見
`docs/superpowers/plans/2026-10-14-account-sync-core.md`。

    npm run test -- src/core/sync        # 只跑同步核心（含兩裝置整合測試）
    npm run worker:dev                   # 本機起 Worker（需要先 d1:migrate:local）
    node worker/scripts/mint-invite.mjs "給 alice"   # 產生邀請碼

伺服器全程看不到明文：雲端只有 `ciphertext` 與 `kind/id/rev/時間/大小`。
`providers.apiKey` 與 `extraHeaders` 永遠不會上傳（有測試守著）。
```

- [ ] **Step 4: 全套測試與建置**

Run: `npm run test && npm run build`
Expected: 全綠，且用例總數約 150+；build 無錯

- [ ] **Step 5: Commit**

```bash
git add src/core/sync/integration.test.ts README.md
git commit -m "test(sync): 兩裝置整合驗收（訊息樹、秘密不外流、離線補推、分批邊界）"
```

---

## Task 16: 真實 `wrangler dev` 冒煙測試（M2 的驗收條件）

單元測試跑的是 `node:sqlite` 替身，workerd 環境的行為（D1 的 `RETURNING`、`ON CONFLICT`、`batch`、CPU 時間）只有在真的 runtime 才算數。這一步把它補上。

**Files:**
- Create: `worker/smoke.mjs`
- Create: `worker/.dev.vars`（**不進版控**）
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 11 的端點
- Produces: 無新介面；`node worker/smoke.mjs` 全綠 = M2 完成

- [ ] **Step 1: 建立本機 dev 的 admin secret，並確保不被提交**

`.gitignore` 追加一行：

```
.dev.vars
```

`worker/.dev.vars`：

```
ADMIN_SECRET=dev-secret
```

Run: `git status --short`
Expected: **看不到** `worker/.dev.vars`（被忽略）

- [ ] **Step 2: 寫 `worker/smoke.mjs`**

```js
// 用法：
//   1) npm run d1:migrate:local
//   2) npm run worker:dev            （另一個終端，等到它印出 http://127.0.0.1:8787）
//   3) node worker/smoke.mjs
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_SECRET ?? 'dev-secret';
const USER = `smoke${Date.now().toString(36).slice(-6)}`;

let failures = 0;
function check(name, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${mark}] ${name}${extra ? ' — ' + extra : ''}`);
}

async function call(path, { method = 'GET', body, token, admin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-secret'] = ADMIN;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const invite = await call('/api/admin/invites', { method: 'POST', admin: true, body: { note: 'smoke' } });
check('管理端產生邀請碼', invite.status === 200 && typeof invite.body.code === 'string', invite.body.code);

const register = await call('/api/auth/register', {
  method: 'POST',
  body: {
    username: USER,
    inviteCode: invite.body.code,
    authKey: 'smoke-auth-key',
    kdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
    wrappedDek: 'smoke-wrapped-dek',
    recoveryAuthKey: 'smoke-recovery-auth',
    recoveryWrappedDek: 'smoke-recovery-wrapped',
    label: 'smoke',
  },
});
check('註冊成功', register.status === 200 && !!register.body.accessToken, `status=${register.status}`);

const me = await call('/api/me', { token: register.body.accessToken });
check('me 回傳帳號', me.status === 200 && me.body.username === USER);

const push = await call('/api/sync/push', {
  method: 'POST',
  token: register.body.accessToken,
  body: {
    records: [{ kind: 'setting', id: 'smoke_1', rev: 1, baseRev: 0, updatedAt: Date.now(), size: 12, ciphertext: 'c21va2UtY3Q' }],
  },
});
check('push 接受一筆', push.status === 200 && push.body.accepted?.length === 1, JSON.stringify(push.body.accepted ?? push.body));

const pull = await call('/api/sync/pull?cursor=0', { token: register.body.accessToken });
check('pull 拿回同一筆且內容未被改動', pull.status === 200 && pull.body.records?.[0]?.ciphertext === 'c21va2UtY3Q', `cursor=${pull.body.cursor}`);
check('pull 回報游標前進', (pull.body.cursor ?? 0) >= 1);

const refresh = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: register.body.refreshToken } });
check('refresh 輪替成功', refresh.status === 200 && refresh.body.accessToken !== register.body.accessToken);

await call('/api/auth/logout', { method: 'POST', token: refresh.body.accessToken });
const afterLogout = await call('/api/me', { token: refresh.body.accessToken });
check('登出後 token 立刻失效', afterLogout.status === 401);

const replay = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: register.body.refreshToken } });
check('舊 refresh token 不可重用', replay.status === 401);

const noToken = await call('/api/sync/pull?cursor=0');
check('未帶 token 被拒', noToken.status === 401);

console.log(failures === 0 ? '\n冒煙測試全部通過。' : `\n有 ${failures} 項失敗。`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: 套用 migration 並起 Worker**

Run: `npm run d1:migrate:local`
Expected: 印出 `0001_init.sql` 已套用（本機 `.wrangler/state` 內）

Run: `npm run worker:dev`（背景執行）
Expected: 印出 `Ready on http://127.0.0.1:8787`（若連接埠被佔用，記下實際埠號並用 `SMOKE_BASE` 覆蓋）

- [ ] **Step 4: 跑冒煙測試**

Run: `node worker/smoke.mjs`
Expected: 全部 `[PASS]`，最後一行 `冒煙測試全部通過。`，退出碼 0

> 若「push 接受一筆」失敗並回 `internal`，八成是 workerd 的 D1 不支援 `INSERT … RETURNING`（rate 表用到）或 `ON CONFLICT … DO UPDATE`。**這時不要改測試**：把 `rate.ts` 改成「先 SELECT 再 UPSERT」的兩步寫法，並在 `worker/test/rate.test.ts` 補一條對應測試（先寫失敗測試再改）。

- [ ] **Step 5: 關掉 Worker 並提交**

```bash
git add worker/smoke.mjs .gitignore
git commit -m "test(worker): 對真實 wrangler dev 的端到端冒煙腳本"
```

---

## 執行期間修正（M1，Task 1–6 實作時發現）

計畫裡的程式碼片段有幾處在真實環境行不通，實作時已修正。**計畫二的實作者請以這一節為準**：

1. **Dexie 的 dbcore middleware 必須在 `db.open()` 之前安裝**（實測結論，非文件記載）：
   - open 前 `use()` → 攔得到寫入 ✅
   - open 後 `use()` → 完全攔不到 ❌（連把 `_core` 設成 null 都無效）
   - 已開的庫只能靠「`close()` → `use()` → `open()`」重建堆疊 ✅
   - 因此 `db.ts` 多了 `onDatabaseCreated(hook)`：新實例在**建立時、還沒 open** 就掛好收斂點；
     `installSyncTap` 改成 async，遇到已開啟的庫會 close → 安裝 → 重開。
2. **IndexedDB 的交易範圍在建立時就固定**：`db.settings.put()` 的自動交易只含 `settings`，
   middleware 想在裡面補寫 `syncOutbox` 會噴 `NotFoundError`。修法是在 `db.ts` 的 `createDb` 裡
   包一層 `_createTransaction`（Dexie 的實例屬性，自動交易與顯式交易都經過它），把 `syncOutbox`
   併進每個讀寫交易的 store 範圍；`outbox.ts` 另留 `Dexie.ignoreTransaction` 的 fallback。
3. **`keyOf` 漏了一張表**：`settings` 的主鍵是 `key` 不是 `id`（14 張表裡唯一的例外），
   原本一律讀 `row.id` 會產生字串 `"undefined"`——同一筆的 put 與 delete 會被當成兩筆，
   同一筆寫兩次又會被 `[kind+id]` 去重成一筆。已修，並補上「14 種 kind 都算得出非 undefined id」的測試。
4. **`Uint8Array<ArrayBuffer>`**：TS 5.7 的泛型化讓裸寫的 `Uint8Array` 傳不進 WebCrypto 的
   `BufferSource`，vitest 抓不到、只有 `npm run build` 會噴。已列入 Global Constraints。
5. **恢復碼正規化的測試自相矛盾**：同一條測試同時要求「保留 I/L」與「I→1、L→1」。以
   「產生時不含 I/L/O/U、手抄時收斂」為準修正測試（實作本來就是對的）。
6. **不要用 PowerShell 改檔案**：`Get-Content -Raw | Set-Content` 會把中文註解變成亂碼並吃掉換行
   （這次真的踩到，`outbox.ts` 整份重寫才救回來）。一律用 read / edit / write 工具。

## 執行期間修正（M2，Task 7–11、16 實作時發現）

1. **`migrations_dir` 不是頂層欄位**，它屬於 **binding 內部**（`d1_databases[].migrations_dir`）。放錯層級時 wrangler 會直接印 usage 並報 `Unknown arguments`，訊息完全指不到真正的原因。
2. **`compatibility_date` 要用 `2026-10-13`，不能用當天（10-14）**：本機 workerd 二進位只支援到前一天，寫當天會起不來（`This Worker requires compatibility date ..., but the newest date supported by this server binary is ...`）。
3. **這個環境的 `node` 是 DSH harness 的包裝腳本**（`harness\.desktop-bin\node.cmd`），它在某些參數型態下會竄改 argv（`--flag` 掉破折號、插入 `cli.js` 路徑）。後果：`npm run worker:dev` / `d1:migrate:*` 這些 npm script 在**本機**會失敗，但**寫法是對的**（一般機器上 `npm run` 走 node_modules/.bin 的 shim 沒問題）。本機要驗證時直接從 PowerShell 呼叫 `wrangler ...`（npm 產的 `.ps1` shim 內部寫的是 `node.exe`，會繞過包裝腳本），或明寫 `node.exe`。
4. **R2 尚未啟用**：`wrangler r2 bucket create` 回 `code: 10042 Please enable R2 through the Cloudflare Dashboard`。這是帳號層級的開關（要你本人去 Dashboard 開，可能需綁付款方式），不影響本機開發（Miniflare 會模擬 R2）與 M2 驗收，但**計畫二的 blob 實際傳輸與 Worker 部署會卡在這一步**。
5. **D1 已建立**：`dsh-sync`，uuid `611a1696-fcb8-4dda-a5c6-aac0f0b6356f`（帳號 `<cloudflare-account>'s Account`）。

## 執行期間修正（M3，Task 12–15 實作時發現）

1. **已同步版本不能存在記錄裡**（計畫原本用 `row.__rev`）。App 的正常寫入是「整筆覆蓋」，
   一寫就把 `__rev` 抹掉，於是第二次推送的 `baseRev` 變回 0、被伺服器判成衝突——
   **第一次推送後再編輯就永遠衝突**。測試直接把這個缺陷抓出來。改成獨立表 `syncRev([kind+id])`，
   App 的寫入再也碰不到它，信封也不必再帶本地欄位。
2. **多裝置測試要用 `openDatabase`，不能用 `switchDatabase`**：後者會 `close()` 掉前一個連線，
   兩個裝置的測試會在第二台建立時把第一台關掉（`DatabaseClosedError`）。
   `openDatabase` 不關舊連線，剛好符合「同一台機器上開兩個庫」的情境。
3. **又踩到一次隨機失敗的斷言**：`expect(ciphertext).not.toContain('18')`——
   base64url 密文湊出 "18" 的機率不低。短字串一律不比對；要驗「真的加密了」就改成
   **解密往返斷言**（解出來的明文等於原本那筆），比掃字串強得多。
4. **`import.meta.url` 在 vitest 的 jsdom 環境不是 `file:` scheme**，`new URL('../migrations/...')`
   會噴 `The URL must be of scheme file`。改成用 `process.cwd()`（vitest 的工作目錄一律是專案根），
   統一收進 `worker/test/helpers/migration.ts`。

## 待辦：個人資訊清理（**使用者指定：計畫二完成後執行**）

以下內容目前已隨本檔推到公開 repo。清理時**不要把實際值寫進任何新提交**——直接刪掉或改成中性描述：

| 位置 | 內容 | 處理 |
|---|---|---|
| `README.md` 第 19 行 | Cloudflare 帳號名稱（含使用者的 Gmail 地址） | 改成中性描述，例如「Cloudflare 帳號（見本機 `wrangler whoami`）」 |
| `README.md` 第 32 行 | 倉庫路徑寫成使用者的 GitHub 帳號 | 改成 `<你的 GitHub 帳號>/AIRoleplay` |
| 本檔第 4260 行附近 | 同一組帳號名稱 + D1 uuid | 只留「D1 已建立」，拿掉帳號名與 uuid |
| `worker/wrangler.jsonc` | D1 `database_id`（資源 id，非個資） | 低風險，可保留；要更乾淨就改讀環境變數並在文件寫明取得方式 |
| `git log` 的 `Initial commit` | 該 commit 的作者是使用者的另一個 email（GitHub 會顯示在 commit 列表與 contributors） | 要一起處理就得在重寫歷史時用 `--mail-map` 改寫 |

**關鍵限制**：改檔案**不會**把上述內容從 git 歷史移除——舊 commit 的 blob 還在。
真正清掉需要重寫歷史（`git filter-repo` 或 BFG + force-push，所有 commit hash 都會變），
或把 repository 改成 private。重寫歷史會影響已 clone 的人，需使用者明確同意才做。

## 計畫完成後的狀態

- 可以註冊（邀請碼）、登入、refresh、登出；session 可即時撤銷。
- 兩台裝置之間能同步 14 張表的資料，雲端只有密文（有金絲雀測試守著）。
- 未登入行為與現在完全一致（既有 93 個用例是這條的守門員）。
- `wrangler dev` 上跑得通端到端冒煙（Task 16）。

**還沒做，留給計畫二（M4–M7）**：

1. **blob 的實際傳輸（儲存體改用 Workers KV，不是 R2）**：目前 `assetMeta` 只送中繼資料，`PUT/GET /api/blob/:id` 還沒實作；
   素材圖與 >256 KiB 的卡片互動頁還沒真的搬。改用 KV 的理由（R2 要綁付款方式）與實作要點見 spec §6.4。
2. **`/api/auth/password`**（改密碼重包 DEK）與 **`/api/auth/recover/start|finish`**（恢復碼救援）——`resets` 表已建好但沒有 handler。
3. **`GET/DELETE /api/devices`**（裝置列表與踢除）。
4. **設定頁 UI**：帳號分節、恢復碼顯示與「我已抄下」、同步狀態、衝突清單、配額、裝置管理。
5. **`blobState` 的懶載入**：拉取時只標記 `remote`，真正抓取與寫回 `assets` 的行為還沒接。
6. **文件**：`AGENTS.md` 第 2 條與第 7 條的硬約束改寫、README 的 Worker 部署章節（`worker:deploy`、`d1:migrate:remote`、`wrangler secret put ADMIN_SECRET`）。
7. **線上驗證**：`wrangler deploy` + 把 `VITE_SYNC_API` 接進 Pages 的建置流程，並在 `air-roleplay.pages.dev` 上實測登入 / 同步 / 未登入三條路徑（spec §12 驗收 8）。
