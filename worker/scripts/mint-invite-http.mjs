#!/usr/bin/env node
/**
 * 一鍵產生邀請碼（走線上 Worker 的 admin 端點，不需要 wrangler / D1 指令）。
 *
 * 用法：
 *   node worker/scripts/mint-invite-http.mjs "給誰用" [有效天數] [Worker 網址]
 *
 * 管理密碼（ADMIN_SECRET）的來源，依序：
 *   1. 環境變數 ADMIN_SECRET
 *   2. 本機 .env.local 的 ADMIN_SECRET=...
 *   3. shots/admin-secret.txt（正式環境的 admin secret，gitignore）
 *
 * 明碼只印一次；資料庫只存 sha256。
 */
import { readFileSync, existsSync } from 'node:fs';

const note = process.argv[2] ?? '';
const ttlRaw = process.argv[3];
const ttlDays = ttlRaw ? Number(ttlRaw) : undefined;
const base = (process.argv[4] ?? process.env.API_BASE ?? 'https://dsh-sync-api.s17179xty.workers.dev').replace(/\/+$/, '');

function readSecret() {
  if (process.env.ADMIN_SECRET) return process.env.ADMIN_SECRET.trim();
  for (const file of ['.env.local', 'shots/admin-secret.txt']) {
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('.txt')) return text.trim();
      const line = text.split(/\r?\n/).find((l) => l.trim().startsWith('ADMIN_SECRET='));
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
    } catch {
      // 換下一個來源
    }
  }
  return '';
}

const secret = readSecret();
if (!secret) {
  console.error('找不到 ADMIN_SECRET：請設定環境變數，或確認 .env.local / shots/admin-secret.txt 存在。');
  process.exit(1);
}

const res = await fetch(base + '/api/admin/invites', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-admin-secret': secret },
  body: JSON.stringify({ note, ...(Number.isFinite(ttlDays) ? { ttlDays } : {}) }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.code) {
  console.error('產生邀請碼失敗（HTTP ' + res.status + '）：' + (body.message ?? JSON.stringify(body)));
  process.exit(1);
}
console.log('');
console.log('  邀請碼：' + body.code);
console.log('  備註：' + (body.note || '（無）'));
console.log('  有效期限：' + (body.expiresAt ? new Date(body.expiresAt).toLocaleString() : '永久（直到被使用）'));
console.log('');
console.log('  只顯示這一次，請立刻複製給要註冊的人（資料庫只存雜湊，之後查不回來）。');
console.log('');
