import { useState } from 'react';

export default function Composer({ disabled, onSend }: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="dsh-tabbar safe-bottom px-4 pt-2.5">
      <div className="flex items-end gap-2">
        <div className="dsh-input flex flex-1 items-end px-3.5 py-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder="开始你的第一次 AI 聊天吧"
            className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-slate-400"
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          className="dsh-btn h-11 min-w-[68px] shrink-0 px-4 text-[14px]"
        >
          发送
        </button>
      </div>
    </div>
  );
}
