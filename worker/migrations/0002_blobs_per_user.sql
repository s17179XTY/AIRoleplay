-- blob 是「每使用者一份」：KV key 已經是 `<userId>/<blobId>`，資料表的主鍵也必須跟上。
--
-- 原本 blobs 的主鍵只有 blob_id（全域唯一），於是「別的帳號上傳過同一個內容」
-- （內容定址 → 同一個 blob_id，例如每個人開局都會上傳的內建卡片頁）
-- 會讓新使用者上傳時撞上主鍵約束 → 500。
--
-- 重建成複合主鍵。既有資料的 blob_id 本來就是全域唯一的，直接搬過來不會衝突。
ALTER TABLE blobs RENAME TO blobs_old;

CREATE TABLE blobs (
  blob_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, blob_id)
);

INSERT INTO blobs (blob_id, user_id, size, created_at, ref_count)
SELECT blob_id, user_id, size, created_at, ref_count FROM blobs_old;

DROP TABLE blobs_old;

CREATE INDEX idx_blobs_user ON blobs(user_id);
