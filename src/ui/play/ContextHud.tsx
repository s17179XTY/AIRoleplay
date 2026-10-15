import { useCallback, useEffect, useState } from 'react';
import { useSession, type ContextPreview } from '../../state/useSession';
import { useData } from '../../state/useData';

/**
 * 顶栏那一行「上下文占用」：一眼看出这一轮要送多少东西、窗口还剩多少。
 *
 * 数字来自 `preview()` —— 它跑的是**和真正发送时同一个** `assemble()`（只是不发请求），
 * 所以显示的和实际发出去的不会对不上。
 */
export default function ContextHud() {
  const preview = useSession((s) => s.preview);
  const modelLabel = useSession((s) => s.modelLabel);
  const messages = useSession((s) => s.messages);
  const draft = useSession((s) => s.draft);
  const memories = useSession((s) => s.memories);
  const chatId = useSession((s) => s.chatId);
  const dataVersion = useData((s) => s.version);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ContextPreview | null>(null);

  const refresh = useCallback(async () => {
    setInfo(await preview());
  }, [preview]);

  useEffect(() => {
    void refresh();
  }, [refresh, messages.length, draft, memories.length, chatId, dataVersion]);

  const used = info?.totalTokens ?? 0;
  const budget = info?.budget ?? 0;
  const windowText = info
    ? (info.mode === 'recent' ? `${info.windowCount}/${info.windowLimit} 条` : `全部 ${info.windowCount} 条`)
    : '—';

  return (
    <>
      <button
        type="button"
        data-testid="context-hud"
        onClick={() => setOpen(true)}
        className="mt-0.5 flex w-full items-center gap-1.5 text-left text-[11px] text-slate-400"
      >
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#34c759]" />
        <span className="truncate">{modelLabel}</span>
        <span className="shrink-0">· 上下文 {windowText} ·</span>
        <span className="shrink-0">~{formatTokens(used)} tok</span>
      </button>

      {open && info && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/35" onClick={() => setOpen(false)}>
          <div className="dsh-sheet max-h-[70%] w-full overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[15px] font-semibold text-slate-800">上下文占用</div>
              <button type="button" className="dsh-chip" onClick={() => setOpen(false)}>关闭</button>
            </div>

            {info.rows.map((row) => (
              <div key={row.label} className="flex items-center justify-between border-b border-black/5 py-2 text-[12px]">
                <span className="text-slate-600">{row.label}</span>
                <span className="text-slate-400">{formatTokens(row.tokens)} tok</span>
              </div>
            ))}

            <div className="mt-2 flex items-center justify-between py-2 text-[12px] font-medium">
              <span className="text-slate-700">合计</span>
              <span className="text-slate-700">{formatTokens(used)} / {formatTokens(budget)} tok</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
              <div
                className="h-full rounded-full bg-[#0072E3]"
                style={{ width: `${Math.min(100, budget > 0 ? Math.round((used / budget) * 100) : 0)}%` }}
              />
            </div>

            <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-slate-400">
              <div>被裁掉：历史 {info.droppedHistory} 条 · 世界书 {info.droppedWorldbook} 条</div>
              <div>记忆库：{info.summaryCount} 条摘要</div>
              <div>
                模式：{info.mode === 'recent' ? `只带最近 ${info.windowLimit} 条消息` : '全部带（靠上下文大小裁剪）'}
                （可在设置里改）
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
