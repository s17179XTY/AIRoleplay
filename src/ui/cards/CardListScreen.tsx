import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardRecord } from '../../core/storage/types';
import { deleteCard, ensureSeedCard, listCards, loadCardPackage, saveCardPackage } from '../../core/storage/cardRepo';
import { packCard, unpackCard } from '../../core/cards/package';
import { importStPng } from '../../core/cards/stCard';
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
    let list = await listCards();
    if (list.length === 0) {
      // 首次打开：先把内置卡种下去，任何入口进来都不会看到空列表
      await ensureSeedCard();
      list = await listCards();
    }
    setCards(list);
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

  const onCreate = () => {
    // 只打开一张空白草稿，点了保存才真正创建
    openEditor(null);
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
      <header className="dsh-header sticky top-0 z-10 px-4 pb-3 pt-3.5">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[17px] font-semibold text-slate-800">我的卡片</div>
            <div className="mt-0.5 text-[11px] text-slate-400">支持 .card.zip 与酒馆 PNG 卡</div>
          </div>
          <span className="dsh-chip">共 {cards.length} 张</span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-3.5 py-3">
        {cards.map((c) => (
          <div key={c.id} className="dsh-card mb-3 p-3.5">
            <div className="flex items-start gap-3">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[18px] font-semibold text-white"
                style={{ background: 'linear-gradient(140deg,#7bb8ff,#0072e3)', boxShadow: '0 6px 16px rgba(0,114,227,0.28)' }}
              >
                {Array.from(c.name)[0] ?? '卡'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-slate-800">{c.name}</div>
                <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-slate-400">
                  {c.description || '（无简介）'}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void onPlay(c.id)} className="dsh-btn px-4 py-2 text-[12px]">
                开始游玩
              </button>
              <button type="button" onClick={() => openEditor(c.id)} className="dsh-chip">编辑</button>
              <button type="button" onClick={() => void onExport(c.id, c.name)} className="dsh-chip">导出</button>
              <button
                type="button"
                onClick={() => void onDelete(c.id)}
                className="dsh-chip"
                style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.22)' }}
              >
                删除
              </button>
            </div>
          </div>
        ))}

        {cards.length === 0 && (
          <div className="mt-16 text-center text-[13px] text-slate-400">还没有卡片，先新建或导入一张</div>
        )}
      </main>

      <div className="dsh-tabbar safe-bottom flex gap-2 px-3.5 py-3">
        <button type="button" onClick={onCreate} className="dsh-btn-ghost flex-1 py-3 text-[13px]">
          新建卡片
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="dsh-btn flex-1 py-3 text-[13px]"
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