#!/usr/bin/env node
// 用法：node worker/scripts/mint-invite.mjs "給 alice" [有效天數]
// 明文邀請碼只印一次、不進資料庫；資料庫只存 sha256。
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
console.log('跑這行寫進 D1（--remote 是線上、拿掉就是本機）：');
console.log(
  `npx wrangler d1 execute dsh-sync --remote --config worker/wrangler.jsonc --command ` +
    `"INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES ('${codeHash}', '${note.replace(/'/g, "''")}', ${now}, ${expiresAt}, NULL, NULL);"`,
);
