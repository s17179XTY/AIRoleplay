import { useCallback, useEffect, useState } from 'react';
import { deleteMod, listMods, saveMod, setModEnabled } from '../../core/storage/modRepo';
import type { ModRecord } from '../../core/storage/types';
import { useNav } from '../../state/useNav';

const inputClass = 'w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0072E3]';

/**
 * MOD：一段可以随时开关的提示词，接在系统提示词之后。
 *
 * 为什么它天然是「热插拔」：每一轮发送前都会重新组装提示词，所以改这里的开关
 * **下一轮立刻生效**，不需要重开对话、也不用重建聊天。
 */
export default function ModSection() {
  const [mods, setMods] = useState<ModRecord[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; content: string } | null>(null);
  const showToast = useNav((s) => s.showToast);

  const refresh = useCallback(async () => {
    setMods(await listMods());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    if (!editing) return;
    if (!editing.content.trim()) {
      showToast('MOD 内容不能为空');
      return;
    }
    await saveMod({ id: editing.id, name: editing.name, content: editing.content });
    setEditing(null);
    await refresh();
    showToast('MOD 已保存（下一轮回复立刻生效）');
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-slate-600">MOD（热插拔提示词）</h2>
        <button type="button" className="text-[12px] text-[#0072E3]"
          onClick={() => setEditing({ name: '', content: '' })}>
          + 新增 MOD
        </button>
      </div>

      <div className="mb-2 rounded-xl bg-black/[0.03] px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        MOD 就是一段提示词，接在系统提示词之后。开着的话**下一轮回复立刻带上它**，
        不用重开对话 —— 想加破甲、加写作要求、临时换风格，都用它。
      </div>

      {mods.map((m) => (
        <div key={m.id} className="dsh-card mb-2 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-slate-700">{m.name}</div>
              <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
                {m.content}
              </div>
            </div>
            <button
              type="button"
              aria-label={`切换 ${m.name}`}
              aria-pressed={m.enabled}
              onClick={() => void setModEnabled(m.id, !m.enabled).then(refresh)}
              className={'relative h-6 w-11 shrink-0 rounded-full transition ' + (m.enabled ? 'bg-[#0072E3]' : 'bg-black/15')}
            >
              <span className={'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ' + (m.enabled ? 'left-[22px]' : 'left-0.5')} />
            </button>
          </div>
          <div className="mt-2 flex gap-3 text-[12px]">
            <button type="button" className="text-slate-500"
              onClick={() => setEditing({ id: m.id, name: m.name, content: m.content })}>
              编辑
            </button>
            <button type="button" className="text-red-500"
              onClick={() => void deleteMod(m.id).then(refresh)}>
              删除
            </button>
          </div>
        </div>
      ))}

      {mods.length === 0 && !editing && (
        <div className="rounded-2xl border border-dashed border-black/15 py-4 text-center text-[12px] text-slate-400">
          还没有 MOD
        </div>
      )}

      {editing && (
        <div className="dsh-card mt-2 space-y-2.5 p-3.5">
          <input className={inputClass} placeholder="MOD 名称，例如「加长回复」" value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <textarea className={inputClass} rows={6} placeholder="要接在系统提示词后面的内容（支持 {{char}} {{user}} 等宏）"
            value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" onClick={() => void onSave()} className="dsh-btn flex-1 py-2.5 text-[13px]">
              保存 MOD
            </button>
            <button type="button" onClick={() => setEditing(null)}
              className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500">取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
