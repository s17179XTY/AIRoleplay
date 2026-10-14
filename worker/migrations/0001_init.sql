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
