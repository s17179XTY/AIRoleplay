import { route } from './router';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // 不要把內部細節洩漏給客戶端；日誌由 Cloudflare 收集（observability 已開）
      const message = err instanceof Error ? err.message : 'internal error';
      console.error('unhandled', message);
      return new Response(JSON.stringify({ ok: false, code: 'internal', message: '伺服器內部錯誤' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
