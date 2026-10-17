import { useEffect } from 'react';
import { useComposer } from '../../state/useComposer';

/**
 * 底部输入列。
 *
 * 严格一对（使用者 2026-10-15 定稿）：**AI 在生成／整理记忆时，输入框与发送键一起锁住**，
 * 只留「停止」—— 这样就不会出现「两条使用者讯息连着」，也保证「按对压缩」永远拿得到完整的交换。
 * 但停止键一定要在：不然卡住就只能重新整理页面。
 *
 * 草稿存在模组层的 useComposer（按 chatId 分），切到别的 tab 再回来不会丢。
 * `safe-bottom` 只给整个画面最底部的那一条（在 AppShell 的导航上），这里只留一般内距。
 */
export default function Composer({
  draftKey, disabled, streaming, summarizing, contextPercent, restoreText, onConsumeRestore,
  onSend, onStop, onOpenContext,
}: {
  /** 草稿归属（对话 id）；换对话就换一份草稿 */
  draftKey: string;
  disabled?: boolean;
  streaming?: boolean;
  summarizing?: boolean;
  /** 0–100，画成输入框右边的环形进度图标 */
  contextPercent?: number;
  restoreText?: string | null;
  onConsumeRestore?: () => void;
  onSend: (text: string) => void;
  onStop?: () => void;
  onOpenContext?: () => void;
}) {
  const key = draftKey || 'default';
  const text = useComposer((s) => s.texts[key] ?? '');
  const locked = Boolean(streaming || summarizing);

  // 在第一个字之前按了停止 → 把刚发的那句话放回输入框，让人改完再发
  useEffect(() => {
    if (restoreText !== null && restoreText !== undefined) {
      useComposer.getState().setText(key, restoreText);
      onConsumeRestore?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreText]);

  const submit = () => {
    if (!text.trim() || disabled || locked) return;
    onSend(text);
    useComposer.getState().clear(key);
  };

  return (
    <div className="dsh-tabbar px-3 pb-1 pt-2.5">
      <div className="flex items-end gap-2">
        <div className="dsh-input flex flex-1 items-end px-3.5 py-2.5">
          <textarea
            value={text}
            disabled={disabled || locked}
            onChange={(e) => useComposer.getState().setText(key, e.target.value)}
            rows={1}
            placeholder={summarizing ? '正在整理之前的记忆…' : streaming ? 'AI 正在回复…' : '开始你的第一次 AI 聊天吧'}
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-slate-400 disabled:opacity-60"
          />
        </div>

        {/* 上下文占用：只有环形图标，没有边框也不占视觉（使用者要求）。按下去才看明细 */}
        <button
          type="button"
          onClick={onOpenContext}
          data-testid="context-button"
          aria-label="上下文占用"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 active:bg-black/5"
        >
          <ContextRing percent={Math.max(0, Math.min(100, contextPercent ?? 0))} />
        </button>

        {locked ? (
          <button
            type="button"
            onClick={onStop}
            data-testid="composer-stop"
            className="composer-stop h-11 min-w-[64px] shrink-0 rounded-full px-4 text-[14px] font-semibold"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="dsh-btn h-11 min-w-[64px] shrink-0 px-4 text-[14px]"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

function ContextRing({ percent }: { percent: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const filled = (percent / 100) * c;
  const color = percent >= 90 ? '#ef4444' : percent >= 75 ? '#f59e0b' : '#0072e3';
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(16,24,40,0.14)" strokeWidth="2.4" />
      <circle
        cx="12" cy="12" r={r} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        transform="rotate(-90 12 12)"
      />
      <text x="12" y="15" textAnchor="middle" fontSize="7.5" fill="#737b8c">{Math.round(percent)}</text>
    </svg>
  );
}
