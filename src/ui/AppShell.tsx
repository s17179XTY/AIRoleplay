import PlayScreen from './play/PlayScreen';
import CardListScreen from './cards/CardListScreen';
import CardEditorScreen from './cards/CardEditorScreen';
import SettingsScreen from './settings/SettingsScreen';
import { useNav } from '../state/useNav';

const TABS: { key: 'cards' | 'play' | 'settings'; label: string; icon: string }[] = [
  { key: 'cards', label: '卡片', icon: '📚' },
  { key: 'play', label: '游玩', icon: '💬' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

export default function AppShell() {
  const tab = useNav((s) => s.tab);
  const editingCardId = useNav((s) => s.editingCardId);
  const setTab = useNav((s) => s.setTab);
  const toast = useNav((s) => s.toast);

  const tabActive = (key: 'cards' | 'play' | 'settings') =>
    tab === key && !editingCardId;

  return (
    <div className="dsh-shell">
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
        <div className="dsh-float pointer-events-none absolute left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-[rgba(20,24,33,0.88)] px-4 py-2 text-[12px] text-white backdrop-blur">
          {toast}
        </div>
      )}

      <nav className="dsh-tabbar safe-bottom flex shrink-0 items-center gap-2 px-4 pt-2.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'dsh-chip flex-1 justify-center border-transparent bg-transparent py-3 text-[12px] ' +
              (tabActive(t.key) ? 'dsh-chip-active' : '')
            }
          >
            <span className="text-[13px]">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}