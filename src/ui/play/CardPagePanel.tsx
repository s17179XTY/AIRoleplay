import { useEffect, useMemo, useRef } from 'react';
import { buildBridgeScript, buildSrcdoc } from '../../core/cards/sandbox';
import type { FieldMap } from '../../core/cards/template';
import { useNav } from '../../state/useNav';

export default function CardPagePanel({ html, title, onExit }: {
  html: string;
  title: string;
  onExit?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const showToast = useNav((s) => s.showToast);
  const srcdoc = useMemo(() => buildSrcdoc(html, buildBridgeScript()), [html]);

  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      const data = ev.data as { __dsh?: boolean; type?: string; payload?: { fields?: FieldMap; text?: string } };
      if (!data || data.__dsh !== true) return;
      if (data.type === 'dsh:copy' && typeof data.payload?.text === 'string' && data.payload.text.trim()) {
        try {
          await navigator.clipboard.writeText(data.payload.text);
          showToast('已复制，粘贴到下面输入框发送即可');
        } catch {
          showToast('复制被浏览器拦截，请长按页面文本手动选择复制');
        }
      }
      if (data.type === 'dsh:toast' && data.payload?.text) showToast(data.payload.text);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [showToast]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="dsh-header flex shrink-0 items-center gap-2 px-4 py-2.5">
        <span className="text-[13px]">📕</span>
        <span className="flex-1 truncate text-[13px] font-semibold text-slate-700">{title}</span>
        {onExit && (
          <button type="button" className="dsh-chip" onClick={onExit}>回到对话</button>
        )}
      </div>

      <div className="min-h-0 flex-1 bg-white">
        <iframe
          ref={iframeRef}
          title="card-page"
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          style={{ width: '100%', height: '100%', border: '0', background: '#f2f2f7', display: 'block' }}
        />
      </div>

      <div className="dsh-tabbar shrink-0 px-4 py-2 text-[11px] leading-relaxed text-slate-500">
        选好 XP 与设定 → 点页面底部「复制内容并开始游戏」→ 粘贴到下面输入框发送。发送后这个页面会自动收起。
      </div>
    </section>
  );
}
