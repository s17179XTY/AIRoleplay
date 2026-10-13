import { create } from 'zustand';

export type Tab = 'cards' | 'play' | 'settings';

export interface NavState {
  tab: Tab;
  editingCardId: string | null;
  toast: string | null;
  setTab: (tab: Tab) => void;
  openEditor: (cardId: string) => void;
  closeEditor: () => void;
  showToast: (text: string) => void;
}

export const useNav = create<NavState>((set) => ({
  tab: 'play',
  editingCardId: null,
  toast: null,
  setTab: (tab) => set({ tab, editingCardId: null }),
  openEditor: (cardId) => set({ editingCardId: cardId, tab: 'cards' }),
  closeEditor: () => set({ editingCardId: null }),
  showToast: (text) => {
    set({ toast: text });
    setTimeout(() => set({ toast: null }), 2500);
  },
}));
