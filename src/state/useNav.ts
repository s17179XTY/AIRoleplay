import { create } from 'zustand';

export type Tab = 'cards' | 'play' | 'settings';

const TABS: Tab[] = ['cards', 'play', 'settings'];

function tabFromHash(): Tab {
  const raw = (globalThis.location?.hash ?? '').replace(/^#\/?/, '');
  const first = raw.split('?')[0] as Tab;
  return TABS.includes(first) ? first : 'play';
}

export interface NavState {
  tab: Tab;
  editorOpen: boolean;
  editingCardId: string | null;
  toast: string | null;
  setTab: (tab: Tab) => void;
  openEditor: (cardId: string | null) => void;
  closeEditor: () => void;
  showToast: (text: string) => void;
}

function syncHash(tab: Tab): void {
  if (typeof globalThis.location === 'undefined') return;
  const next = '#/' + tab;
  if (globalThis.location.hash !== next) globalThis.location.hash = next;
}

export const useNav = create<NavState>((set) => ({
  tab: tabFromHash(),
  editorOpen: false,
  editingCardId: null,
  toast: null,
  setTab: (tab) => {
    syncHash(tab);
    set({ tab, editorOpen: false, editingCardId: null });
  },
  openEditor: (cardId) => set({ editorOpen: true, editingCardId: cardId, tab: 'cards' }),
  closeEditor: () => set({ editorOpen: false, editingCardId: null }),
  showToast: (text) => {
    set({ toast: text });
    setTimeout(() => set({ toast: null }), 2500);
  },
}));

// 支持浏览器前进/后退与深链：地址栏 hash 变化时同步当前标签
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('hashchange', () => {
    const next = tabFromHash();
    if (useNav.getState().tab !== next) {
      useNav.setState({ tab: next, editorOpen: false, editingCardId: null });
    }
  });
}