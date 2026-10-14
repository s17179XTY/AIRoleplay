import { corsHeaders, route } from './router';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // 不要把內部細節洩漏給客戶端；日誌由 Cloudflare 收集（observability 已開）
      const message = err instanceof Error ? err.message : 'internal error';
      console.error('unhandled', message);
      /*
       * 一定要帶 CORS 標頭：沒有它，瀏覽器會把整個 500 回應丟掉，
       * 前端只能看到 TypeError（Safari 顯示 “Load failed”），真正的錯誤訊息到不了使用者眼裡。
       * 一個普通的 D1 約束錯誤就是這樣被誤認成網路問題、白查了很久。
       */
      const cors = corsHeaders(env, request.headers.get('origin'));
      return new Response(JSON.stringify({ ok: false, code: 'internal', message: '伺服器內部錯誤' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
      });
    }
  },
};
