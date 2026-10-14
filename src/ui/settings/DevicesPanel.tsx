import { useEffect, useState } from 'react';
import { useSync, type SyncSeams } from '../../state/useSync';

function formatWhen(value: number): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 已登入裝置清單：可踢掉其他裝置（被踢的那台 token 立刻失效） */
export default function DevicesPanel({ seams = {} }: { seams?: SyncSeams }) {
  const devices = useSync((s) => s.devices) ?? [];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) void useSync.getState().loadDevices(seams);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="rounded-xl bg-black/[0.03] px-3 py-2">
      <button type="button" className="flex w-full items-center justify-between text-[12px] text-slate-600"
        onClick={() => setOpen((v) => !v)}>
        <span>已登录的设备</span>
        <span className="text-slate-400">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {devices.length === 0 && <div className="text-[11px] text-slate-400">读取中…</div>}
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-slate-600">
                {d.label}
                {d.current && <span className="ml-1 text-[#0072E3]">（这台）</span>}
              </span>
              <span className="shrink-0 text-slate-400">{formatWhen(d.lastSeenAt)}</span>
              {!d.current && (
                <button type="button" disabled={busy} className="shrink-0 text-red-500"
                  onClick={() => {
                    setBusy(true);
                    void useSync.getState().revokeDevice(d.id, seams).finally(() => setBusy(false));
                  }}>
                  踢掉
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
