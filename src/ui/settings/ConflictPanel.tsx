import { useCallback, useEffect, useState } from 'react';
import { db, type ConflictRecord } from '../../core/storage/db';
import { decryptEnvelope } from '../../core/sync/envelope';
import { SYNC_TABLES, type SyncKind } from '../../core/sync/kinds';
import { setRev } from '../../core/sync/engine';
import { useSync } from '../../state/useSync';

/**
 * 冲突面板：把 `syncConflicts` 里那些「推送被拒、服务器赢」的版本解出来给使用者看。
 *
 * 库里存的是密文，但 DEK 在内存里（解锁后），所以能解密后展示。
 * 「用这一版覆盖回去」= 写回原表 + 把本地 rev 对齐到那一版，这样**下一次推送会被接受**
 * （如果只是写回本地而不动 rev，下一轮推送又会因为 baseRev 对不上再冲突一次，等于白做）。
 */
interface DecodedConflict extends ConflictRecord {
  table: string;
  preview: string;
  row?: Record<string, unknown>;
  error?: string;
}

export default function ConflictPanel() {
  const conflicts = useSync((s) => s.conflicts);
  const [items, setItems] = useState<DecodedConflict[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const decode = useCallback(async () => {
    const rows = await db.syncConflicts.toArray();
    const dek = useSync.getState().currentDek();
    const out: DecodedConflict[] = [];
    for (const row of rows) {
      const table = SYNC_TABLES[row.kind as SyncKind] ?? row.kind;
      if (!dek) {
        out.push({ ...row, table, preview: '（已上锁，解锁后可以看内容）' });
        continue;
      }
      try {
        const envelope = await decryptEnvelope<Record<string, unknown>>(dek, row.kind, row.id, row.ciphertext);
        const data = { ...envelope.data };
        delete data.__fileKey;
        out.push({ ...row, table, row: data, preview: previewOf(data) });
      } catch (err) {
        out.push({ ...row, table, preview: '（解不开这一版）', error: err instanceof Error ? err.message : String(err) });
      }
    }
    setItems(out);
  }, []);

  useEffect(() => {
    if (open) void decode();
  }, [open, decode, conflicts]);

  const restore = async (item: DecodedConflict) => {
    if (!item.row || item.seq === undefined) return;
    setBusy(true);
    try {
      const kind = item.kind as SyncKind;
      const table = SYNC_TABLES[kind];
      if (!table) return;
      // 写回原表（outbox 收敛点会自动把它排进待推送）
      await (db.table(table) as { put: (v: unknown) => Promise<unknown> }).put(item.row);
      // 本地 rev 对齐到这一版 → 下一次推送 baseRev 会对上，服务器会接受
      await setRev(db, kind, item.id, item.rev);
      await db.syncConflicts.delete(item.seq);
      await decode();
    } finally {
      setBusy(false);
    }
  };

  if (conflicts === 0) return null;

  return (
    <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
      <div className="flex items-start justify-between gap-2">
        <span>{conflicts} 笔冲突：另一台设备的改动被覆盖前留了一份副本。</span>
        <button type="button" className="shrink-0 underline" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '查看'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          {items.map((item) => (
            <div key={String(item.seq)} className="rounded-lg bg-white/70 px-3 py-2">
              <div className="text-[11px] text-slate-500">
                {item.table} · {item.id} · rev {item.rev}
              </div>
              <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-slate-600">{item.preview}</div>
              {item.row && (
                <button
                  type="button"
                  disabled={busy}
                  className="mt-1.5 text-[11px] text-[#0072E3] underline"
                  onClick={() => void restore(item)}
                >
                  用这一版覆盖回去
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="text-[11px] text-slate-500 underline"
            onClick={() => void useSync.getState().dismissConflicts().then(decode)}
          >
            全部丢弃
          </button>
        </div>
      )}
    </div>
  );
}

function previewOf(data: Record<string, unknown>): string {
  const pick = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
  const text = pick('raw') || pick('text') || pick('content') || pick('title') || pick('name') || pick('value');
  if (text) return text.slice(0, 160);
  return JSON.stringify(data).slice(0, 160);
}
