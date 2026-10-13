import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardRecord } from '../../core/storage/types';
import { deleteCard, listCards, loadCardPackage, saveCardPackage } from '../../core/storage/cardRepo';
import { packCard, unpackCard } from '../../core/cards/package';
import { importStPng } from '../../core/cards/stCard';
import { emptyCardJson } from '../../core/cards/spec';
import { useNav } from '../../state/useNav';
import { useSession } from '../../state/useSession';
import { downloadBytes, readFileBytes } from './fileUtils';

export default function CardListScreen() {
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const openCard = useSession((s) => s.openCard);
  const setTab = useNav((s) => s.setTab);
  const openEditor = useNav((s) => s.openEditor);
  const showToast = useNav((s) => s.showToast);

  const refresh = useCallback(async () => {
    setCards(await listCards());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onImport = async (file: File) => {
    setBusy(true);
    try {
      const bytes = await readFileBytes(file);
      const lower = file.name.toLowerCase();
      const pkg = lower.endsWith('.png') ? importStPng(bytes) : unpackCard(bytes);
      if (!pkg.json.name) pkg.json.name = file.name.replace(/\.[^.]+$/, '');
      pkg.json.id = '';
      const id = await saveCardPackage(pkg);
      await refresh();
      showToast('导入成功：' + pkg.json.name);
      openEditor(id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    const json = emptyCardJson('新卡片');
    json.firstMessage = '';
    const id = await saveCardPackage({ json, texts: [], assets: [] });
    await refresh();
    openEditor(id);
  };

  const onExport = async (cardId: string, name: string) => {
    const pkg = await loadCardPackage(cardId);
    if (!pkg) return;
    downloadBytes(packCard(pkg), name + '.card.zip', 'application/zip');
  };

  const onDelete = async (cardId: string) => {
    await deleteCard(cardId);
    await refresh();
    showToast('已删除');
  };

  const onPlay = async (cardId: string) => {
    await openCard(cardId);
    setTab('play');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-white/90 px-3 pb-2 pt-3 backdrop-blur">
        <div className="text-[15px] font-semibold text-slate-800">我的卡片</div>
        <div className="text-[11px] text-slate-400">共 {cards.length} 张 · 支持 .card.zip 与酒馆 PNG 卡</div>
      </header>

      <main className="flex-1 overflow-y-auto px-3 py-2">
        {cards.map((c) => (
          <div key={c.id} className="mb-2 rounded-2xl bg-white p-3 shadow-sm">
            <div className="truncate text-[14px] font-medium text-slate-800">{c.name}</div>
            <div className="mt-0.5 line-clamp-2 text-[12px] text-slate-400">
              {c.description || '（无简介）'}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onPlay(c.id)}
                className="rounded-xl bg-[#0072E3] px-3 py-1.5 text-[12px] font-medium text-white active:opacity-80"
              >
                开始游玩
              </button>
              <button
                type="button"
                onClick={() => openEditor(c.id)}
                className="rounded-xl border border-black/10 px-3 py-1.5 text-[12px] text-slate-600 active:bg-black/5"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => void onExport(c.id, c.name)}
                className="rounded-xl border border-black/10 px-3 py-1.5 text-[12px] text-slate-600 active:bg-black/5"
              >
                导出
              </button>
              <button
                type="button"
                onClick={() => void onDelete(c.id)}
                className="rounded-xl border border-red-100 px-3 py-1.5 text-[12px] text-red-500 active:bg-red-50"
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {cards.length === 0 && (
          <div className="mt-10 text-center text-[13px] text-slate-400">还没有卡片，先新建或导入一张</div>
        )}
      </main>

      <div className="safe-bottom flex gap-2 border-t border-black/5 bg-white/95 px-3 py-2">
        <button
          type="button"
          onClick={() => void onCreate()}
          className="flex-1 rounded-2xl border border-black/10 py-2.5 text-[13px] text-slate-700 active:bg-black/5"
        >
          新建卡片
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="flex-1 rounded-2xl bg-[#0072E3] py-2.5 text-[13px] font-medium text-white active:opacity-80 disabled:opacity-50"
        >
          导入卡片
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.png"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onImport(file);
          }}
        />
      </div>
    </div>
  );
}
