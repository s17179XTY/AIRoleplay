import { useEffect } from 'react';
import PlayScreen from './play/PlayScreen';
import CardListScreen from './cards/CardListScreen';
import CardEditorScreen from './cards/CardEditorScreen';
import SettingsScreen from './settings/SettingsScreen';
import { useNav } from '../state/useNav';
import { useSetting } from '../state/useSetting';
import { useSync } from '../state/useSync';

const TABS: { key: 'cards' | 'play' | 'settings'; label: string; icon: string }[] = [
  { key: 'cards', label: '卡片', icon: '📚' },
  { key: 'play', label: '游玩', icon: '💬' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

export default function AppShell() {
  const tab = useNav((s) => s.tab);
  const editorOpen = useNav((s) => s.editorOpen);
  const editingCardId = useNav((s) => s.editingCardId);
  const setTab = useNav((s) => s.setTab);
  const toast = useNav((s) => s.toast);
  const refreshSync = useSync((s) => s.refresh);
  const [fontScale] = useSetting('fontScale', '16');

  /**
   * 啟動時就跑一次登入狀態檢查。
   * 一定要在 AppShell（而不是只放在設定頁）：若 token 還在，這裡會把連線切回帳號專屬的庫，
   * 否則重新載入頁面後看到的是未登入那一份資料，使用者會以為同步過的資料全沒了。
   */
  useEffect(() => {
    refreshSync();
  }, [refreshSync]);

  // 正文字号全局生效：设置页点一下，聊天里的气泡与折叠面板立刻变
  useEffect(() => {
    document.documentElement.style.setProperty('--dsh-fs', (Number(fontScale) || 16) + 'px');
  }, [fontScale]);

  const tabActive = (key: 'cards' | 'play' | 'settings') =>
    tab === key && !editorOpen;

  return (
    <div className="dsh-shell">
      <div className="min-h-0 flex-1">
        {editorOpen ? (
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

      <nav className="dsh-tabbar safe-bottom flex shrink-0 items-center gap-2.5 px-3.5 pb-1 pt-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              // 注意：.dsh-chip 自带 padding，Tailwind 的 py-* 会被它盖掉 —— 用 min-h 控制高度才有效
              'dsh-chip flex-1 flex-col justify-center gap-1.5 border-transparent bg-transparent min-h-[64px] text-[13px] ' +
              (tabActive(t.key) ? 'dsh-chip-active' : '')
            }
          >
            <span className="text-[19px] leading-none">{t.icon}</span>
            <span className="text-[12px] leading-none">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}