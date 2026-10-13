import { useState, type ReactNode } from 'react';

export default function Collapse({ summary, children, defaultOpen = false }: {
  summary: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="dsh-panel my-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] font-medium text-[#2b6cb0] active:opacity-70"
      >
        <span className={'text-[10px] transition-transform ' + (open ? 'rotate-90' : '')}>{'▶'}</span>
        <span className="flex-1">{summary || '详情'}</span>
      </button>
      {open && (
        <div className="px-3.5 pb-3 pt-0.5 text-[13px] leading-relaxed text-slate-600">
          {children}
        </div>
      )}
    </div>
  );
}
