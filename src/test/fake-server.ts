/// <reference types="node" />
import { route } from '../../worker/src/router';
import { makeTestEnv } from '../../worker/test/helpers/env';
import { MIGRATION_SQL } from '../../worker/test/helpers/migration';
import type { Env } from '../../worker/src/types';

/** 每個測試都用一個乾淨的 Worker 環境（真的 D1 替身 + 真的 router） */
export function makeWorkerEnv(): Env {
  return makeTestEnv(MIGRATION_SQL);
}

/** 把 Worker 的 route() 包成 fetch 形狀，於是前端程式碼完全不知道自己在跟假伺服器講話 */
export function makeFakeServer(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    return route(request, env);
  }) as typeof fetch;
}

/** 幫測試帳號種一張邀請碼（註冊流程要用） */
export async function seedInvite(env: Env, code: string): Promise<void> {
  const { sha256Hex } = await import('../../worker/src/http');
  await env.DB.prepare('INSERT INTO invites (code_hash, note, created_at, expires_at, used_by, used_at) VALUES (?,?,?,?,NULL,NULL)')
    .bind(await sha256Hex(code), 'test', 1, null)
    .run();
}
