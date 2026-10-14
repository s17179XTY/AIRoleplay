// 真實 runtime 的端到端冒煙測試（單元測試跑的是 node:sqlite 替身，這裡跑 workerd + 真的 D1/R2 模擬）。
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
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 120) };
  }
  return { status: res.status, body: parsed };
}

const invite = await call('/api/admin/invites', { method: 'POST', admin: true, body: { note: 'smoke' } });
check('管理端產生邀請碼', invite.status === 200 && typeof invite.body.code === 'string', invite.body.code ?? JSON.stringify(invite.body));

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
check('註冊成功', register.status === 200 && !!register.body.accessToken, `status=${register.status} ${JSON.stringify(register.body).slice(0, 120)}`);

const me = await call('/api/me', { token: register.body.accessToken });
check('me 回傳帳號', me.status === 200 && me.body.username === USER);

const push = await call('/api/sync/push', {
  method: 'POST',
  token: register.body.accessToken,
  body: {
    records: [{ kind: 'setting', id: 'smoke_1', rev: 1, baseRev: 0, updatedAt: Date.now(), size: 12, ciphertext: 'c21va2UtY3Q' }],
  },
});
check(
  'push 接受一筆',
  push.status === 200 && push.body.accepted?.length === 1,
  JSON.stringify(push.body.accepted ?? push.body),
);

const pull = await call('/api/sync/pull?cursor=0', { token: register.body.accessToken });
check(
  'pull 拿回同一筆且內容未被改動',
  pull.status === 200 && pull.body.records?.[0]?.ciphertext === 'c21va2UtY3Q',
  `cursor=${pull.body.cursor}`,
);
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

const notFound = await call('/api/nope');
check('未知路徑回 404（不是 401）', notFound.status === 404);

// 上面的登出已經把 token 撤銷了，後續段落要用新登入的 session（這是腳本自己的順序問題，不是伺服器 bug）
const reLogin = await call('/api/auth/login', {
  method: 'POST',
  body: { username: USER, authKey: 'smoke-auth-key', label: 'smoke-2' },
});
check('重新登入取得新 session', reLogin.status === 200, `status=${reLogin.status}`);
const session = reLogin.body.accessToken;

// ── blob（KV）往返 ────────────────────────────────────────────────
const big = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
const putBlob = await fetch(`${BASE}/api/blob/smoke-blob-1`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${session}`, 'content-type': 'application/octet-stream' },
  body: big,
});
check('PUT /api/blob 接受 1 MiB', putBlob.status === 200, `status=${putBlob.status}`);

const gotBlob = await fetch(`${BASE}/api/blob/smoke-blob-1`, {
  headers: { authorization: `Bearer ${session}` },
});
const gotBytes = new Uint8Array(await gotBlob.arrayBuffer());
check(
  'GET /api/blob 原樣取回 1 MiB',
  gotBlob.status === 200 && gotBytes.length === big.length && gotBytes[1000] === big[1000],
  `status=${gotBlob.status} len=${gotBytes.length}`,
);

const missingBlob = await fetch(`${BASE}/api/blob/nope-nope`, {
  headers: { authorization: `Bearer ${session}` },
});
check('不存在的 blob 回 404（交由客戶端重試）', missingBlob.status === 404);

const anonBlob = await fetch(`${BASE}/api/blob/smoke-blob-1`);
check('未帶 token 的 blob 請求被拒', anonBlob.status === 401);

// ── 改密碼 ────────────────────────────────────────────────────────
const changePw = await call('/api/auth/password', {
  method: 'POST',
  token: session,
  body: {
    oldAuthKey: 'smoke-auth-key',
    newAuthKey: 'smoke-auth-key-2',
    newKdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
    newWrappedDek: 'smoke-wrapped-dek-2',
    newRecoveryAuthKey: 'smoke-recovery-2',
    newRecoveryWrappedDek: 'smoke-recovery-wrapped-2',
  },
});
check('改密碼成功', changePw.status === 200, `status=${changePw.status}`);

const oldLogin = await call('/api/auth/login', { method: 'POST', body: { username: USER, authKey: 'smoke-auth-key' } });
check('改密碼後舊密碼登不進去', oldLogin.status === 401);

const newLogin = await call('/api/auth/login', { method: 'POST', body: { username: USER, authKey: 'smoke-auth-key-2' } });
check('改密碼後新密碼可以登入', newLogin.status === 200);

// ── 恢復碼救援 ────────────────────────────────────────────────────
const recoverStart = await call('/api/auth/recover/start', {
  method: 'POST',
  body: { username: USER, recoveryAuthKey: 'smoke-recovery-2' },
});
check(
  '救援第一步：拿到 resetToken 與 recoveryWrappedDek',
  recoverStart.status === 200 && !!recoverStart.body.resetToken && !!recoverStart.body.recoveryWrappedDek,
  `status=${recoverStart.status}`,
);

const recoverFinish = await call('/api/auth/recover/finish', {
  method: 'POST',
  body: {
    resetToken: recoverStart.body.resetToken,
    newAuthKey: 'smoke-auth-key-3',
    newKdf: '{"algo":"PBKDF2-SHA256","iters":600000,"v":1}',
    newWrappedDek: 'smoke-wrapped-dek-3',
    newRecoveryAuthKey: 'smoke-recovery-3',
    newRecoveryWrappedDek: 'smoke-recovery-wrapped-3',
  },
});
check('救援第二步：完成', recoverFinish.status === 200, `status=${recoverFinish.status}`);

const revokedAfterRecover = await call('/api/me', { token: newLogin.body.accessToken });
check('救援後所有舊 session 失效', revokedAfterRecover.status === 401);

const rescuedLogin = await call('/api/auth/login', { method: 'POST', body: { username: USER, authKey: 'smoke-auth-key-3' } });
check('救援後用新密碼登入成功', rescuedLogin.status === 200);

const replayReset = await call('/api/auth/recover/finish', {
  method: 'POST',
  body: {
    resetToken: recoverStart.body.resetToken,
    newAuthKey: 'x', newKdf: '{}', newWrappedDek: 'w', newRecoveryAuthKey: 'ra', newRecoveryWrappedDek: 'rw',
  },
});
check('resetToken 不能重複使用', replayReset.status === 401);

const devices = await call('/api/devices', { token: rescuedLogin.body.accessToken });
check(
  '裝置列表回傳目前這台',
  devices.status === 200 && devices.body.devices?.length >= 1 && devices.body.devices.some((d) => d.current),
  `count=${devices.body.devices?.length}`,
);

console.log(failures === 0 ? '\n冒煙測試全部通過。' : `\n有 ${failures} 項失敗。`);
process.exit(failures === 0 ? 0 : 1);
