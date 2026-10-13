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
  editingCardId: string | null;
  uiCardId: string | null;
  toast: string | null;
  setTab: (tab: Tab) => void;
  openEditor: (cardId: string) => void;
  closeEditor: () => void;
  openCardUi: (cardId: string) => void;
  closeCardUi: () => void;
  showToast: (text: string) => void;
}

function syncHash(tab: Tab): void {
  if (typeof globalThis.location === 'undefined') return;
  const next = '#/' + tab;
  if (globalThis.location.hash !== next) globalThis.location.hash = next;
}

export const useNav = create<NavState>((set) => ({
  tab: tabFromHash(),
  editingCardId: null,
  uiCardId: null,
  toast: null,
  setTab: (tab) => {
    syncHash(tab);
    set({ tab, editingCardId: null, uiCardId: null });
  },
  openEditor: (cardId) => set({ editingCardId: cardId, uiCardId: null, tab: 'cards' }),
  closeEditor: () => set({ editingCardId: null }),
  openCardUi: (cardId) => set({ uiCardId: cardId, editingCardId: null, tab: 'cards' }),
  closeCardUi: () => set({ uiCardId: null }),
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
      useNav.setState({ tab: next, editingCardId: null, uiCardId: null });
    }
  });
}
