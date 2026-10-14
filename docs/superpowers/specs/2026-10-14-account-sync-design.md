# 帳號與雲端同步（零知識加密）設計

- 日期：2026-10-14
- 狀態：設計已逐節確認，待使用者審 spec
- 前置文件：[2026-10-13-fengyue-like-roleplay-app-design.md](2026-10-13-fengyue-like-roleplay-app-design.md)
- 這份設計**推翻**前置文件的兩條決定：第 15 行「純本地單機版、無帳號」與第 33 行「不做帳號系統、雲同步」

## 1. 目的

換手機 / 換瀏覽器時，卡片、會話、訊息、記憶能自動同步，取代現在的「匯出 / 匯入全量 zip」。**本地仍是主副本**：沒登入時行為與現在完全一致。

已確認的七個取捨（來源：本次需求澄清）：

| # | 取捨 | 決定 |
|---|---|---|
| 1 | 目的 | 跨裝置同步（雲端是同步後端，不是主儲存） |
| 2 | 同步範圍 | 全量：卡片（含互動頁 HTML）、會話、訊息、記憶、世界書、正則、設定、素材圖 |
| 3 | API Key | **永不上雲**（連 `extraHeaders` 也不上，見 §6.7） |
| 4 | 內容加密 | 全程端到端加密，伺服器零知識 |
| 5 | 登入方式 | 帳號名 + 密碼（**不寄信、無 Email**） |
| 6 | 寄信 | 不做，零外部依賴 |
| 7 | 註冊開放度 | 邀請碼制（站長 + 朋友） |

## 2. 範圍

**做**：帳號（註冊 / 登入 / 登出 / 改密碼 / 恢復碼救援）、邀請碼、增量同步（文本類）、blob 同步（素材圖與大檔）、衝突副本保留、裝置管理、同步狀態 UI。

**不做（YAGNI）**：Email 與 OAuth、分享卡片 / 社群、伺服器端搜尋、多帳號同時登入、欄位級合併 / CRDT、雲端檔案預覽、付費與計費（§6.4 的配額只是容量保護，不是商業方案）。

## 3. 總體架構

```
瀏覽器 PWA（Pages 專案 air-roleplay，靜態部署不變）
  │  fetch + Bearer token（跨來源，CORS 白名單）
  ▼
dsh-sync-api（新增獨立 Worker，wrangler deploy，workers.dev 子域，不需要域名）
  ├─ D1：users / invites / sessions / records / changes / blobs / rate
  └─ R2：blob 密文（素材圖、> 256 KiB 的文本）
```

- 靜態站與 API **各自獨立部署**，互不綁死。前端以建置變數 `VITE_SYNC_API` 取得 API base URL。
- 憑證用 **Bearer token，不用 cookie**：跨來源 cookie 要 `SameSite=None; Secure` 且易踩 CSRF；內容本來就是密文，token 洩漏的爆炸半徑只到「能讀寫你的密文」。
- Worker **不做任何解密**，也不記密文到日誌。

### 元件邊界

| 新增 | 職責 | 依賴 |
|---|---|---|
| `worker/` | 獨立 Worker：auth、邀請碼、增量同步、blob 收發 | D1、R2 |
| `src/core/sync/crypto.ts` | 純函式：KDF、信封加解密、恢復碼包裝 | WebCrypto，**不 import React** |
| `src/core/sync/client.ts` | HTTP 客戶端：重試、401 自動 refresh | fetch |
| `src/core/sync/engine.ts` | 同步引擎：outbox 推送、游標拉取、衝突處理、blob 收發 | Dexie、crypto、client |
| `src/core/sync/kinds.ts` | 各表 ↔ 同步信封的映射（含 provider 剝除秘密欄位） | 純函式 |
| `src/ui/settings/AccountSection.tsx` | 帳號 / 同步 UI | 既有設定頁 |

### 資料流

UI 操作 → 寫 Dexie（**本地立刻生效，不等網路**）→ storage 層同一個收斂點打 rev 並塞 `syncOutbox` → 引擎在有網路時把**密文**推上 Worker → 另一台裝置 pull 拿密文 → 本地用 DEK 解開 → 寫回 Dexie → 既有 UI 訂閱自動更新（渲染層不改）。

## 4. 金鑰階層與加密規格

```
密碼 + 帳號名(小寫)
 ├─ PBKDF2-SHA256(pw, "dsh1|auth|"+user, iters) → authKey   ──→ 送出（伺服器再雜湊存）
 └─ PBKDF2-SHA256(pw, "dsh1|enc|"+user,  iters) → masterKey ──→ 永不出網
       └─ AES-GCM 解開 wrappedDek → DEK（32 隨機位元組，一帳號一把）
             ├─ 記錄：AES-GCM(DEK, iv=12B 隨機, 明文)，AAD = kind + "|" + id
             └─ blob：fileKey(32B 隨機) 加密檔案，fileKey 用 DEK 包好放信封內
```

- **參數**：`PBKDF2-HMAC-SHA256`，正式 600000 迭代（OWASP 建議），測試 1000 迭代。迭代數**必須可注入**（`crypto.ts` 一律收 `kdf` 參數，不讀模組常數）。
- **kdf 描述子**存在 `users.kdf`：`{"algo":"PBKDF2-SHA256","iters":600000,"v":1}`，未來換演算法可灰度升級。
- **明文信封**（加密前的內容）固定格式，讓客戶端能自行偵測回滾與搬移：

```json
{ "v": 1, "rev": 3, "updatedAt": 1760412345678, "deviceId": "dev_xxx", "data": { } }
```

- 伺服器只看到 `kind / id / rev / updated_at / size / ciphertext`。**卡片名、會話標題、設定內容全在密文內**。
- `id` 一律隨機 uuid（沿用 `newId()`），不洩漏語意。
- 不用 Argon2id 的理由：WebCrypto 沒有原生實作，要引入 wasm（體積 + 依賴）；PBKDF2 原生、可測、夠用。`kdf` 描述子讓未來升級不需要改協定。

### 4.1 恢復碼

- 隨機 256 位元 → Base32（Crockford，去掉易混淆字元）→ 52 字元，顯示時分組 `XXXX-XXXX-…`。
- 由恢復碼衍生**兩個互不相關的值**（與密碼同構）：`recoveryAuthKey = PBKDF2(code,"dsh1|rec|"+user, 200000)`（送伺服器驗證）、`recoveryKey` 本身用於解開 `recoveryWrappedDek`。
- 伺服器只存 `recovery_hash`（recoveryAuthKey 再雜湊）與 `recovery_wrapped_dek`（密文）。**伺服器不保存恢復碼本身，站長也救不了沒抄的人。**
- 註冊成功後**強制顯示一次**，須勾選「我已抄下」才能繼續。

## 5. 身分與授權

### 5.1 D1 schema

```sql
users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, kdf TEXT NOT NULL,
      auth_hash TEXT NOT NULL, auth_salt TEXT NOT NULL,
      wrapped_dek TEXT NOT NULL, recovery_wrapped_dek TEXT NOT NULL,
      recovery_hash TEXT NOT NULL, recovery_salt TEXT NOT NULL,
      quota_bytes INTEGER NOT NULL DEFAULT 1073741824, used_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);

invites(code_hash TEXT PRIMARY KEY, note TEXT, created_at INTEGER NOT NULL,
        expires_at INTEGER, used_by TEXT, used_at INTEGER);
-- expires_at 可為 NULL = 永不過期；用過即不可再用（一次性）

sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, access_hash TEXT NOT NULL,
         access_expires_at INTEGER NOT NULL, refresh_hash TEXT NOT NULL, refresh_expires_at INTEGER NOT NULL,
         label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
         revoked INTEGER NOT NULL DEFAULT 0);

records(user_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, size INTEGER NOT NULL, ciphertext TEXT, blob_ref TEXT,
        PRIMARY KEY (user_id, kind, id));

changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
CREATE INDEX idx_changes_user_seq ON changes(user_id, seq);

blobs(blob_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, size INTEGER NOT NULL,
      created_at INTEGER NOT NULL, ref_count INTEGER NOT NULL DEFAULT 1);

resets(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
       used INTEGER NOT NULL DEFAULT 0);  -- 恢復碼救援用的一次性 resetToken，5 分鐘有效

rate(bucket TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL,
     PRIMARY KEY (bucket, window_start));
```

### 5.2 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/register` | `{username, inviteCode, authKey, authSalt, kdf, wrappedDek, recoveryAuthKey, recoveryWrappedDek}` |
| POST | `/api/auth/login` | `{username, authKey}` → `{accessToken, refreshToken, expiresIn}` |
| POST | `/api/auth/refresh` | `{refreshToken}` → 輪替後的新 token 對 |
| POST | `/api/auth/logout` | 撤銷當前 session |
| POST | `/api/auth/password` | `{oldAuthKey, newAuthKey, newKdf, newWrappedDek, newRecoveryAuthKey, newRecoveryWrappedDek}` |
| POST | `/api/auth/recover/start` | `{username, recoveryAuthKey}` → `{resetToken}`（5 分鐘、一次性） |
| POST | `/api/auth/recover/finish` | `{resetToken, newAuthKey, newKdf, newWrappedDek, newRecoveryAuthKey, newRecoveryWrappedDek}` → 撤銷所有 session |
| GET | `/api/me` | `{username, createdAt, quota:{used, limit}}` |
| GET | `/api/sync/pull?cursor=&limit=` | 見 §6.2 |
| POST | `/api/sync/push` | 見 §6.3 |
| PUT / GET | `/api/blob/:blobId` | 原樣收發密文中繼資料，單檔上限 8 MiB |
| GET | `/api/devices` / DELETE `/api/devices/:id` | 裝置列表 / 踢除 |
| POST | `/api/admin/invites` | 需 `X-Admin-Secret`，產生一次性邀請碼 |

- 伺服器端 `auth_hash = PBKDF2-SHA256(authKey, auth_salt, 200000)`，**與客戶端 KDF 參數無關**（authKey 已是高熵值，不需 600k）。
- 登入失敗一律回「帳號名或密碼錯誤」，不洩漏帳號是否存在。
- 限流（`rate` 表 + 每分鐘窗口）：register/login 10 次/IP/分、recover 5 次/帳號/時、sync 120 次/帳號/分、blob 60 次/帳號/分。
- CORS 白名單由 Worker 環境變數 `ALLOWED_ORIGINS` 控制（初始：`https://air-roleplay.pages.dev`）。
- 邀請碼以 `sha256(code)` 入庫（不存明文），支援 `expires_at` 與 `note`（記「給誰的」）。
- 帳號名規則：3–32 字元，`[a-z0-9_-]`（存小寫），保留字 `admin` / `api` / `local` 禁止。

## 6. 同步協定

### 6.1 游標

`changes` 是追加日誌，每次變更（含刪除）拿一個單調 `seq`。拉取 = `SELECT … FROM changes WHERE user_id=? AND seq>? ORDER BY seq LIMIT n`，再用 `(kind,id)` 批次取 `records`。**不依賴任何裝置時鐘**。

刪除語意：刪一筆記錄 = 刪 `records` 那一行 + 追加一筆 `changes(deleted=1)`；拉取端只看 `changes` 就能知道「這個 (kind,id) 沒了」，不會因為 join 不到而漏掉墓碑。

### 6.2 拉取

```
GET /api/sync/pull?cursor=1234&limit=200
→ { cursor: 1434, hasMore: true,
    records: [ { kind, id, deleted:false, rev, updatedAt, size, ciphertext, blobRef } ],
    quota: { used, limit } }
```

`deleted:true` 的條目不帶 `ciphertext`（墓碑）。`blobRef` 只給 id 與 size，**blob 本體懶載入**（真的要用到才抓）。

### 6.3 推送

```
POST /api/sync/push
{ records: [ { kind, id, rev, baseRev, updatedAt, deleted, size, ciphertext, blobRef } ] }
→ { accepted: [ { kind, id, rev } ],
    conflicts: [ { kind, id, serverRev, serverCiphertext？ } ],
    quota: { used, limit } }
```

- `baseRev == 伺服器現值` → 快進接受，`rev = baseRev + 1`。
- `baseRev != 伺服器現值` → **衝突**：仍接受（LWW，以到達順序為準，`rev = max(伺服器 rev, 客戶端 rev) + 1`），回報 `conflicts[]`；被覆蓋的伺服器版本在**≤ 64 KiB** 時一併回傳，客戶端解密後存進本地 `syncConflicts`。超過 64 KiB 只回報不帶內容（避免回應膨脹）。
- 每批上限 200 筆、請求體上限 4 MiB；超過則由客戶端分批。
- 推送與拉取都冪等：重送同一批以 `rev` 判定，不產生重複。

### 6.4 blob

- 門檻：**文本 > 256 KiB 或任何二進位 → 走 blob**（D1 單行上限 2 MB，內建卡互動頁 1.25 MB 已貼紅線）。
- `blobId = base64url(sha256(明文))`（內容定址，天然去重、免衝突）。
- 檔案格式：`"DSHB1" | iv(12B) | AES-GCM(fileKey, iv, 明文, AAD=blobId)`；`fileKey` 用 DEK 包好、base64 放在信封的 `data.__fileKey`。
- 流程：先推 `assetMeta` / `cardFile` 信封（帶 `blobRef`）→ `PUT /api/blob/:blobId` 上傳密文 → 本地 `blobState.state` 由 `local` 轉 `uploaded`。拉取端看到 `blobRef` 且本地沒有 → 顯示佔位，真正要用時才 `GET` 並解密寫進 `assets`。
- 單檔上限 8 MiB；帳號配額預設 1 GiB（`quota_bytes`），超過回 `413` + 用量。
- 回收：`records` 刪除時把對應 `blobs.ref_count` 減一，歸零就刪 R2 物件並扣回 `used_bytes`。

### 6.5 outbox（離線佇列）

- 所有會同步的表寫入都經過 storage 層的**同一個收斂點**：打 rev、寫 `syncOutbox`。
- 失敗指數退避（1s → 2s → 4s …上限 5 分鐘）；離線就躺著，UI 顯示「N 筆待同步」。
- **未登入時不啟用 outbox**（不累積、不影響現有行為）。

### 6.6 首次註冊的資料認領

未登入期間累積的本地資料，在註冊成功後做一次**全量初始推送**（分批 + 進度顯示），完成才切換到增量模式。單向操作：匿名庫原樣保留。

### 6.7 秘密欄位

`providers` 同步時**同時剝掉 `apiKey` 與 `extraHeaders`**（後者也可能被塞自訂 `Authorization`）。雲端只留 `{id, label, protocol, baseUrl, createdAt}`。新裝置登入後看得到服務商設定但沒有金鑰，UI 明確顯示「此裝置尚未設定 API Key，請重新貼上」。

> 註：這比需求澄清時說的「剝掉 apiKey」再嚴一格，原因是 `extraHeaders` 同樣可能承載秘密。這是本設計的刻意加嚴。

## 7. 本地資料與帳號隔離

- `src/core/storage/db.ts` 由 `export const db` 改為 `export let db` + `openDatabase(name)` / `switchDatabase(name)`（ESM live binding，呼叫端照舊寫 `db.xxx`）。
- DB 名稱：未登入 `dsh-roleplay`；登入帳號 `dsh-roleplay@<username>`。
- **前置檢查（M1 第一步）**：掃 18 個 import 點 / 37 個使用點，確認全部是「呼叫時取值」，沒有把 `db` 或某張表快取到模組層。
- 首次註冊：把匿名庫 14 張表逐表複製進新庫（走 `db.tables` 通用迴圈，約 15 行）。
- 登出：切回匿名庫；帳號庫**留在裝置上**（不刪），設定頁提供「清除此裝置上的帳號資料」。
- 新增四張表（Dexie `version(2)`，只加表）：
  - `syncOutbox: '++seq, kind'`
  - `syncState: 'key'`（`accountId / username / cursor / deviceId / dekFingerprint / lastSyncAt`）
  - `syncConflicts: '++seq, kind, id'`
  - `blobState: 'blobId, state, refId'`
- `dekFingerprint = sha256(DEK)`，用來判斷「這個庫是不是這個帳號的」；不符就報「此裝置資料屬於其他帳號」，而不是把 `OperationError` 丟給使用者看。

## 8. UI 規格

設定頁新增「帳號」分節（首頁與其他頁面**一個字都不改**）。

| 狀態 | 顯示 |
|---|---|
| 未登入 | 登入 / 註冊（需邀請碼）。不彈窗、不擋任何功能 |
| 註冊 | 帳號名 + 密碼 + 邀請碼 → 顯示恢復碼 → 勾「我已抄下」→ 首次全量推送（進度條） |
| 已登入 | 帳號名、同步狀態（已同步 / 同步中 / N 筆待推 / 上次同步時間）、立即同步、裝置列表（可踢）、改密碼、**重新產生恢復碼**（需輸入密碼；舊碼即刻失效）、登出（可勾清除本地） |
| 有衝突 | 「N 筆衝突已保留本地副本」+ 可展開清單 |
| 配額 | `已用 / 上限` 進度條 |

錯誤文案對照：

| 情境 | 文案 |
|---|---|
| 邀請碼無效 / 已用 / 過期 | 「邀請碼無效或已被使用」 |
| 帳號名佔用 | 「這個帳號名已經有人用了」 |
| 帳號名不合規則 | 「帳號名 3–32 字元，只能用小寫字母、數字、- 和 _」 |
| 登入失敗 | 「帳號名或密碼錯誤」 |
| 5xx / 429 | 「伺服器忙，稍後自動重試」 |
| 解密失敗 | 「此裝置的資料屬於其他帳號，請切回原帳號或先匯出備份」 |
| 配額滿 | 「雲端空間已滿（X / Y），請清理或匯出備份」 |
| 離線 | 不報錯，狀態列顯示待同步筆數 |

## 9. 安全要點

- Worker 不解密、不印密文；`wrangler tail` 看到的只有信封欄位。
- access token 15 分鐘（存雜湊，可即時撤銷）、refresh token 30 天（每次刷新輪替、只存雜湊）。
- 改密碼：客戶端用舊 `masterKey` 解出 DEK → 用新密碼重新包 `wrappedDek` 與恢復碼包 → 伺服器驗舊 `authKey` 後更新。**其他已登入裝置在記憶體中的 DEK 失效前仍可用**（refresh 後需用新密碼解鎖）。
- 卡片 iframe 仍是 `sandbox="allow-scripts"` + `connect-src 'none'`，拿不到 token 也碰不到資料庫。
- `localStorage` 存 token 的 XSS 風險由既有防線壓制（DOMPurify 白名單清洗 + 卡片 iframe 無同源）。

## 10. 測試策略

- **jsdom 缺 `crypto.subtle`**（已實測：只有 `getRandomValues`）。`src/test/setup.ts` 補：

```ts
import { webcrypto } from 'node:crypto';
const c = globalThis.crypto;
if (c && !c.subtle) Object.defineProperty(c, 'subtle', { value: webcrypto.subtle, configurable: true });
```

（只補 `subtle`、不整顆換掉 `crypto`，是為了保住 jsdom 的 `randomUUID`／`getRandomValues`，`newId()` 仰賴它們。）

- `crypto.ts` 純函式單元測試：加解密往返、AAD 防搬移（換 id 必失敗）、錯 key 必失敗、恢復碼往返、KDF 迭代數注入。
- 同步引擎：**兩台假裝置**（兩個 Dexie 實例、不同 DB 名）+ 記憶體版 Worker handler + 假 D1/R2，驗證推送→拉取→解密一致、衝突留副本、墓碑、離線補推。
- Worker 邏輯抽成純函式（`handleRegister(env, body)` 等）配薄的 D1/R2 adapter，**不引入 `@cloudflare/vitest-pool-workers`**。
- 另有 smoke 腳本：`wrangler d1 migrations apply --local` + `wrangler dev`，真打一輪註冊 → 推送 → 拉取。
- UI 改動照 `AGENTS.md`：無頭 Chrome + CDP 實測（沿用 `shots/` 既有腳本）。

## 11. 里程碑（每個都要 `npm run test` 全綠 + `npm run build` 通過）

| M | 內容 | 完成標準 |
|---|---|---|
| M1 | `crypto.ts`、`kinds.ts`、jsdom polyfill、`db.ts` 可換庫 + 前置掃描 | 加密往返測試綠；既有 93 用例不受影響 |
| M2 | Worker + D1 migrations + 註冊 / 登入 / 邀請碼 / refresh / 限流 | smoke 腳本對 `wrangler dev` 跑通 |
| M3 | 同步引擎 records（游標 / LWW / outbox / 首次全量） | 兩假裝置端到端一致測試 |
| M4 | blob / R2（大檔、素材圖、懶載入、配額） | 1.25 MiB 卡片頁往返成功 |
| M5 | UI（帳號分節、恢復碼、狀態、衝突、裝置、配額） | CDP 截圖 + 未登入行為不變 |
| M6 | 改密碼重包 DEK、恢復碼救援 | 忘密碼情境實測救回 |
| M7 | 文件：`AGENTS.md` 硬約束改寫、README 補 Worker 部署 | 文件與實作一致 |

## 12. 驗收標準

1. 未登入：93 個既有用例全綠，功能與現在完全一樣。
2. 兩個 Chrome profile 同帳號：A 發訊息 → B 拉到且解密可讀。
3. `wrangler d1 execute "select ciphertext from records limit 1" --remote` 出的**不是明文**。
4. `kind='provider'` 的雲端記錄裡找不到任何 `apiKey` 或 `extraHeaders` 痕跡。
5. 改密碼後：同一台裝置的既有本地資料仍可讀（DEK 沒變），新裝置用新密碼登入能解；舊裝置下次重新解鎖時必須輸入**新**密碼（舊密碼算出的 `masterKey` 已解不開重包後的 `wrappedDek`）。
6. 恢復碼救援：在一台全新的裝置用「帳號名 + 恢復碼」救回並重設密碼，雲端資料完整還原；救援後舊 session 全數失效；**沒有恢復碼時無法救援**（實測會被拒）。
7. 邀請碼一次性；無碼註冊被拒。
8. 離線發 3 條訊息 → 恢復網路自動補齊，另一裝置可見。
9. 部署後 `air-roleplay.pages.dev` 實測登入 / 同步 / 未登入三條路徑。

## 13. 對既有硬約束的修訂

`AGENTS.md`：

- 第 2 條「**零後端**：不引入任何需要伺服器的功能」→「**本地優先**：未登入時功能與純本地版完全一致；登入後雲端只作**加密同步後端**，伺服器不得持有明文」。
- 第 7 條（模型由使用者自己接）補一句：API Key 與 `extraHeaders` **永不上雲**。

前置設計文件 `2026-10-13-fengyue-like-roleplay-app-design.md`：第 15、33 行加註「已由 2026-10-14 帳號與雲端同步設計取代」。

## 14. 已知限制與風險

- **忘記密碼又丟了恢復碼 = 雲端資料永久無法解開**（設計上的必然，本地副本仍在）。
- 低階手機 600k 迭代可能 2–3 秒；必要時降到 310k 或改 Argon2id wasm（`kdf` 描述子已預留升級）。
- 兩台同時編輯同一張卡會靜默 LWW 覆蓋（本地留副本，但不做 UI 合併）。
- D1 免費方案每次呼叫 50 條查詢上限、單行 2 MB；批次與 blob 門檻即為此設計。
- 免費額度：D1 每庫 500 MB / 每帳號 5 GB；R2 10 GB 儲存。超出的用量需要付費。
- 匿名庫「認領」是單向操作，重複註冊不同帳號不會互相污染（DB 名隔離），但匿名資料只會被第一個註冊的帳號帶走。
