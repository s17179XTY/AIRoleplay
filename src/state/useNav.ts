import { create } from 'zustand';

export type Tab = 'cards' | 'play' | 'settings';

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

export const useNav = create<NavState>((set) => ({
  tab: 'play',
  editingCardId: null,
  uiCardId: null,
  toast: null,
  setTab: (tab) => set({ tab, editingCardId: null }),
  openEditor: (cardId) => set({ editingCardId: cardId, uiCardId: null, tab: 'cards' }),
  closeEditor: () => set({ editingCardId: null }),
  openCardUi: (cardId) => set({ uiCardId: cardId, editingCardId: null, tab: 'cards' }),
  closeCardUi: () => set({ uiCardId: null }),
  showToast: (text) => {
    set({ toast: text });
    setTimeout(() => set({ toast: null }), 2500);
  },
}));
