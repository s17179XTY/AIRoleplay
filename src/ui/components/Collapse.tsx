import { useState, type ReactNode } from 'react';

export default function Collapse({ summary, children, defaultOpen = false }: {
  summary: string; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-black/10 bg-black/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] font-medium text-slate-500 active:bg-black/5"
      >
        <span>{summary || '详情'}</span>
        <span className={'transition-transform ' + (open ? 'rotate-90' : '')}>{'\u25B8'}</span>
      </button>
      {open && (
        <div className="border-t border-black/5 px-3 py-2 text-[13px] leading-relaxed text-slate-600">
          {children}
        </div>
      )}
    </div>
  );
}
