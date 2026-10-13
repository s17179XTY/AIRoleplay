import PlayScreen from './play/PlayScreen';
import CardListScreen from './cards/CardListScreen';
import CardEditorScreen from './cards/CardEditorScreen';
import SettingsScreen from './settings/SettingsScreen';
import { useNav } from '../state/useNav';

const TABS: { key: 'cards' | 'play' | 'settings'; label: string }[] = [
  { key: 'cards', label: '卡片' },
  { key: 'play', label: '游玩' },
  { key: 'settings', label: '设置' },
];

export default function AppShell() {
  const tab = useNav((s) => s.tab);
  const editingCardId = useNav((s) => s.editingCardId);
  const setTab = useNav((s) => s.setTab);
  const toast = useNav((s) => s.toast);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {editingCardId ? (
          <CardEditorScreen cardId={editingCardId} />
        ) : tab === 'cards' ? (
          <CardListScreen />
        ) : tab === 'settings' ? (
          <SettingsScreen />
        ) : (
          <PlayScreen />
        )}
      </div>

      {toast && (
        <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl bg-black/80 px-3 py-2 text-[12px] text-white">
          {toast}
        </div>
      )}

      <nav className="safe-bottom flex shrink-0 border-t border-black/10 bg-white">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'flex-1 py-3 text-[12px] ' +
              (tab === t.key && !editingCardId ? 'font-semibold text-[#0072E3]' : 'text-slate-400')
            }
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
