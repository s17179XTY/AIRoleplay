import { authenticate, handleCreateInvite, handleLogin, handleLogout, handleMe, handleRefresh, handleRegister } from './auth';
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

  // 以下都需要有效的 access token。順序很重要：先確認路徑存在（不存在就 404），再驗身分，
  // 否則「未帶 token 打未知路徑」會回 401，等於洩漏「這個路徑存在」。
  const protectedRoutes: Record<string, string> = {
    '/api/auth/logout': 'POST',
    '/api/me': 'GET',
    '/api/sync/pull': 'GET',
    '/api/sync/push': 'POST',
  };
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

  if (path === '/api/sync/pull') {
    const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
    const limit = Number(url.searchParams.get('limit') ?? '200') || 200;
    return toResponse(await handlePull(env, auth.userId, cursor, limit), cors);
  }

  return toResponse(await handlePush(env, auth.userId, await readJson(request), now), cors);
}
