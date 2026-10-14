import { useEffect, useMemo, useRef, useState } from 'react';
import { buildBridgeScript, buildSrcdoc } from '../../core/cards/sandbox';
import type { FieldMap } from '../../core/cards/template';
import { useNav } from '../../state/useNav';

export default function CardPagePanel({ html, title }: { html: string; title: string }) {
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(420);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const showToast = useNav((s) => s.showToast);

  const srcdoc = useMemo(() => buildSrcdoc(html, buildBridgeScript()), [html]);

  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      const data = ev.data as { __dsh?: boolean; type?: string; payload?: { fields?: FieldMap; height?: number; text?: string } };
      if (!data || data.__dsh !== true) return;
      if (data.type === 'dsh:ready' || data.type === 'dsh:fields') {
        const h = data.payload?.height;
        if (typeof h === 'number' && h > 0) setHeight(Math.max(320, Math.min(720, Math.round(h * 0.62))));
      }
      if (data.type === 'dsh:copy' && typeof data.payload?.text === 'string' && data.payload.text.trim()) {
        try {
          await navigator.clipboard.writeText(data.payload.text);
          showToast('初始化信息已复制，粘贴到下方输入框发送即可');
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
    <section className="mx-3 mt-2 overflow-hidden rounded-2xl bg-white shadow-[0_8px_26px_rgba(0,114,227,0.10),0_1px_3px_rgba(16,24,40,0.05)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="text-[14px]">📕</span>
        <span className="flex-1 truncate text-[13px] font-semibold text-slate-700">{title} · 卡片互动页</span>
        <span className="dsh-chip">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <>
          <div className="border-t border-black/5">
            <iframe
              ref={iframeRef}
              title="card-page"
              sandbox="allow-scripts"
              srcDoc={srcdoc}
              style={{ width: '100%', height, border: '0', background: '#f2f2f7', display: 'block' }}
            />
          </div>
          <div className="border-t border-black/5 bg-[#f7f9fc] px-3.5 py-2 text-[11px] leading-relaxed text-slate-500">
            在页面里选好 XP 与设定 → 点页面底部「复制内容并开始游戏」→ 把复制到的【初始信息设定】粘贴到下面输入框发送。
          </div>
        </>
      )}
    </section>
  );
}
