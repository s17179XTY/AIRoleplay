import { useState } from 'react';

/**
 * 底部輸入列。
 *
 * 注意 `safe-bottom`：**只有整個畫面最底部的那一條**可以吃安全區留白。
 * 這裡上面還有 AppShell 的底部導航，兩條都加 safe-bottom 會疊出兩份留白，
 * 看起來就是「消息框下面多出一大塊空位」——所以這裡只留一般內距。
 */
export default function Composer({ disabled, streaming, onSend, onStop }: {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    // streaming 期間只顯示「停止」；這裡再擋一次，避免任何路徑把使用者打好的字吃掉
    if (!text.trim() || disabled || streaming) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="dsh-tabbar px-4 pb-1 pt-2.5">
      <div className="flex items-end gap-2">
        <div className="dsh-input flex flex-1 items-end px-3.5 py-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder={streaming ? '正在生成…可以直接打下一句' : '开始你的第一次 AI 聊天吧'}
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-slate-400"
          />
        </div>
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            data-testid="composer-stop"
            className="composer-stop h-11 min-w-[68px] shrink-0 rounded-full px-4 text-[14px] font-semibold"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="dsh-btn h-11 min-w-[68px] shrink-0 px-4 text-[14px]"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
