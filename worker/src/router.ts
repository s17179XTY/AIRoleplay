import { handleDeleteAccount } from './account';
import {
  authenticate, handleChangePassword, handleCreateInvite, handleListDevices, handleLogin, handleLogout, handleMe,
  handleRecoverFinish, handleRecoverStart, handleRefresh, handleRegister, handleRevokeDevice,
} from './auth';
import { handleGetBlob, handlePutBlob } from './blob';
import { fail, type ApiReply } from './http';
import { handlePull, handlePush } from './sync';
import type { Env } from './types';

/**
 * 預覽部署（`https://<hash>.air-roleplay.pages.dev`）。
 * 不能只列正式域名——預覽網址也是同一個專案、同一份 bundle，漏掉會讓登入直接被 CORS 擋掉
 * （Safari 只會顯示 “Load failed”，完全看不出原因）。
 */
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.air-roleplay\.pages\.dev$/;

/**
 * 本機開發來源：`npm run dev` 會同時開 localhost 與區網 IP（手機要連同一個 Wi-Fi 測），
 * 這些都只在本網段內，且 API 本來就要求 token，放行不增加風險。
 */
const LOCAL_DEV_ORIGIN_RE =
  /^http:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

export function isAllowedOrigin(env: Env, origin: string): boolean {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  if (PREVIEW_ORIGIN_RE.test(origin)) return true;
  if (LOCAL_DEV_ORIGIN_RE.test(origin)) return true;
  return false;
}

export function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  if (!origin || !isAllowedOrigin(env, origin)) return {};
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
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

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

  if (path === '/api/auth/recover/start') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleRecoverStart(env, await readJson(request), now), cors);
  }

  if (path === '/api/auth/recover/finish') {
    if (method !== 'POST') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    return toResponse(await handleRecoverFinish(env, await readJson(request), now), cors);
  }

  // blob 走二進位通道（不是 JSON）。順序與其他受保護路徑一致：先確認路徑形狀，再驗身分。
  const blobMatch = path.match(/^\/api\/blob\/([^/]+)$/);
  if (blobMatch) {
    if (method !== 'PUT' && method !== 'GET') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    const auth = await authenticate(env, request.headers.get('authorization'), now);
    if (!auth) return toResponse(fail(401, 'unauthorized', '請先登入'), cors);
    const blobId = decodeURIComponent(blobMatch[1]);
    if (method === 'PUT') {
      const bytes = await request.arrayBuffer();
      const replace = url.searchParams.get('replace') === '1';
      return toResponse(await handlePutBlob(env, auth.userId, blobId, bytes, now, replace), cors);
    }
    const reply = await handleGetBlob(env, auth.userId, blobId);
    if (!reply.bytes) return toResponse(reply, cors);
    return new Response(reply.bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(reply.bytes.byteLength),
        'cache-control': 'private, no-store',
        ...cors,
      },
    });
  }

  // 以下都需要有效的 access token。順序很重要：先確認路徑存在（不存在就 404），再驗身分，
  // 否則「未帶 token 打未知路徑」會回 401，等於洩漏「這個路徑存在」。
  const protectedRoutes: Record<string, string> = {
    '/api/auth/logout': 'POST',
    '/api/me': 'GET',
    '/api/sync/pull': 'GET',
    '/api/sync/push': 'POST',
    '/api/devices': 'GET',
    '/api/auth/password': 'POST',
    // 刪除帳號（雲端變更日誌、密文、blob、所有 session 一次清掉）
    '/api/account': 'DELETE',
  };
  const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
  if (deviceMatch) {
    if (method !== 'DELETE') return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);
    const auth = await authenticate(env, request.headers.get('authorization'), now);
    if (!auth) return toResponse(fail(401, 'unauthorized', '請先登入'), cors);
    return toResponse(await handleRevokeDevice(env, auth.userId, decodeURIComponent(deviceMatch[1])), cors);
  }

  const expectedMethod = protectedRoutes[path];
  if (!expectedMethod) return toResponse(fail(404, 'not_found', '找不到端點'), cors);
  if (method !== expectedMethod) return toResponse(fail(405, 'method_not_allowed', '方法不允許'), cors);

  const auth = await authenticate(env, request.headers.get('authorization'), now);
  if (!auth) return toResponse(fail(401, 'unauthorized', '請先登入'), cors);

  if (path === '/api/auth/logout') {
    return toResponse(await handleLogout(env, auth.sessionId), cors);
  }

  if (path === '/api/me') {
    return toResponse(await handleMe(env, auth.sessionId), cors);
  }

  if (path === '/api/devices') {
    return toResponse(await handleListDevices(env, auth.userId, auth.sessionId), cors);
  }

  if (path === '/api/auth/password') {
    return toResponse(await handleChangePassword(env, auth.userId, await readJson(request)), cors);
  }

  if (path === '/api/account') {
    return toResponse(await handleDeleteAccount(env, auth.userId), cors);
  }

  if (path === '/api/sync/pull') {
    const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const limit = Number(url.searchParams.get('limit') ?? '200') || 200;
    return toResponse(await handlePull(env, auth.userId, cursor, limit), cors);
  }

  return toResponse(await handlePush(env, auth.userId, await readJson(request), now), cors);
}