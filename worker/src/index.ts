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
      /*
       * 把「額度/資源用盡」跟「程式 bug」分開回報，前端才能給對的指示：
       * - D1/KV 額度、subrequest/查詢數超限、CPU 超時 → 503 backend_quota（叫使用者等，不要重試爆打）
       * - 其餘 → 500 internal（是真的壞了，要留原文給人查，不要誤導成額度）
       */
      const quota = /D1_ERROR|KV (PUT|GET) failed|Too many|exceeded|subrequest|quota|1102|1202/i.test(message);
      return new Response(JSON.stringify(
        quota
          ? { ok: false, code: 'backend_quota', message: '雲端額度/資源暫時用盡，請稍後再試（本機資料不受影響）' }
          : { ok: false, code: 'internal', message: '伺服器內部錯誤（不是你的帳號或資料問題）' },
      ), {
        status: quota ? 503 : 500,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
      });
    }
  },
};