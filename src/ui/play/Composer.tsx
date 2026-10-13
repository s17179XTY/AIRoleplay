import { useState } from 'react';

export default function Composer({ disabled, onSend }: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="safe-bottom border-t border-black/10 bg-white/95 px-3 py-2 backdrop-blur">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder="开始你的第一次 AI 聊天吧"
          className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl bg-black/5 px-3 py-2.5 text-[14px] outline-none placeholder:text-slate-400"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="h-10 shrink-0 rounded-2xl bg-[#0072E3] px-4 text-[14px] font-medium text-white active:opacity-80 disabled:opacity-40"
        >
          发送
        </button>
      </div>
    </div>
  );
}
