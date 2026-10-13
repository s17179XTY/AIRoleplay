import { useEffect, useMemo, useRef, useState } from 'react';
import { loadCardPackage } from '../../core/storage/cardRepo';
import { findText, type CardPackage } from '../../core/cards/package';
import { buildBridgeScript, buildSrcdoc } from '../../core/cards/sandbox';
import { renderTemplate, type FieldMap } from '../../core/cards/template';
import { useNav } from '../../state/useNav';
import { useSession } from '../../state/useSession';

let collectorOverride: (() => Promise<FieldMap>) | null = null;
export function setFieldCollector(fn: (() => Promise<FieldMap>) | null): void {
  collectorOverride = fn;
}

function fallbackTemplate(fields: FieldMap): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v.values.length > 0)
    .map(([k, v]) => k + '：' + v.labels.join('、'));
  return ['【初始信息设定】', ...lines].join('\n');
}

export default function CardUiScreen({ cardId }: { cardId: string }) {
  const [pkg, setPkg] = useState<CardPackage | null>(null);
  const [fields, setFields] = useState<FieldMap>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [height, setHeight] = useState(360);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pending = useRef<((f: FieldMap) => void) | null>(null);

  const closeCardUi = useNav((s) => s.closeCardUi);
  const setTab = useNav((s) => s.setTab);
  const showToast = useNav((s) => s.showToast);
  const openCard = useSession((s) => s.openCard);
  const startFromUi = useSession((s) => s.startFromUi);

  useEffect(() => {
    void (async () => {
      const loaded = await loadCardPackage(cardId);
      if (!loaded) {
        showToast('卡片不存在');
        closeCardUi();
        return;
      }
      setPkg(loaded);
    })();
  }, [cardId, closeCardUi, showToast]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { __dsh?: boolean; type?: string; payload?: { fields?: FieldMap; height?: number } };
      if (!data || data.__dsh !== true) return;
      if (data.type === 'dsh:fields' && data.payload?.fields) {
        setFields(data.payload.fields);
        if (data.payload.height) setHeight(Math.max(240, Math.min(900, data.payload.height)));
        if (pending.current) {
          pending.current(data.payload.fields);
          pending.current = null;
        }
      }
      if (data.type === 'dsh:ready' && data.payload?.height) {
        setHeight(Math.max(240, Math.min(900, data.payload.height)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const html = pkg ? findText(pkg, pkg.json.ui?.entry) : null;
  const srcdoc = useMemo(() => (html ? buildSrcdoc(html, buildBridgeScript()) : ''), [html]);

  const collect = (): Promise<FieldMap> => {
    if (collectorOverride) return collectorOverride();
    return new Promise((resolve) => {
      pending.current = resolve;
      iframeRef.current?.contentWindow?.postMessage({ __dshCmd: 'collect' }, '*');
      setTimeout(() => {
        if (pending.current) {
          pending.current(fields);
          pending.current = null;
        }
      }, 500);
    });
  };

  const onGenerate = async () => {
    if (!pkg) return;
    setBusy(true);
    try {
      const collected = await collect();
      const template = findText(pkg, pkg.json.promptTemplate) ?? '';
      const text = template.trim()
        ? renderTemplate(template, {
            fields: collected,
            scenario: pkg.json.scenario,
            persona: pkg.json.persona.intro,
            cardName: pkg.json.name,
            user: '我',
            date: new Date().toISOString().slice(0, 10),
            time: new Date().toTimeString().slice(0, 5),
          })
        : fallbackTemplate(collected);
      setPreview(text);
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await startFromUi(cardId, preview);
      closeCardUi();
      setTab('play');
    } finally {
      setBusy(false);
    }
  };

  const onSkip = async () => {
    await openCard(cardId);
    closeCardUi();
    setTab('play');
  };

  const onCopy = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview);
      showToast('已复制到剪贴板');
    } catch {
      showToast('复制失败，请手动长按选择');
    }
  };

  if (!pkg) {
    return <div className="flex h-full items-center justify-center text-[13px] text-slate-400">加载中…</div>;
  }

  if (preview !== null) {
    return (
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-black/5 bg-white/90 px-3 pb-2 pt-3 backdrop-blur">
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setPreview(null)} className="text-[13px] text-slate-500">返回</button>
            <div className="text-[14px] font-semibold text-slate-800">提示词预览</div>
            <button type="button" onClick={() => void onCopy()} className="text-[13px] text-slate-500">复制</button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-3 py-3">
          <textarea
            className="h-full min-h-[60vh] w-full rounded-2xl border border-black/10 bg-white p-3 font-mono text-[12px] leading-relaxed outline-none"
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
          />
        </main>
        <div className="safe-bottom border-t border-black/5 bg-white/95 px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onStart()}
            className="w-full rounded-2xl bg-[#0072E3] py-3 text-[14px] font-medium text-white disabled:opacity-50"
          >
            开始游玩
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-white/90 px-3 pb-2 pt-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <button type="button" onClick={closeCardUi} className="text-[13px] text-slate-500">返回</button>
          <div className="truncate px-2 text-[14px] font-semibold text-slate-800">{pkg.json.name}</div>
          <button type="button" onClick={() => void onSkip()} className="text-[13px] text-slate-500">跳过界面</button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-2 py-2">
        {html ? (
          <iframe
            ref={iframeRef}
            title="card-ui"
            sandbox="allow-scripts"
            srcDoc={srcdoc}
            style={{ width: '100%', height: height, border: '0', background: '#fff', borderRadius: 12 }}
          />
        ) : (
          <div className="p-4 text-center text-[13px] text-slate-400">这张卡片没有交互界面，可直接开始游玩</div>
        )}
      </main>

      <div className="safe-bottom border-t border-black/5 bg-white/95 px-3 py-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onGenerate()}
          className="w-full rounded-2xl bg-[#0072E3] py-3 text-[14px] font-medium text-white disabled:opacity-50"
        >
          生成提示词
        </button>
      </div>
    </div>
  );
}
