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

console.log(failures === 0 ? '\n冒煙測試全部通過。' : `\n有 ${failures} 項失敗。`);
process.exit(failures === 0 ? 0 : 1);
