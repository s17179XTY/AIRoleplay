import { create } from 'zustand';

/**
 * 输入框草稿（按对话 id 存）。
 *
 * 为什么要放到 store 而不是 Composer 的 useState：切到「卡片 / 设置」再切回来时
 * PlayScreen 会被卸载，组件内 state 直接消失 —— 使用者回来发现刚打的一大段字没了。
 * 这里放在模组层，重挂载后原样取回；发送成功才清掉。
 */
export interface ComposerDraftState {
  texts: Record<string, string>;
  setText: (key: string, text: string) => void;
  clear: (key: string) => void;
}

export const useComposer = create<ComposerDraftState>((set) => ({
  texts: {},
  setText: (key, text) => set((state) => (
    state.texts[key] === text ? state : { texts: { ...state.texts, [key]: text } }
  )),
  clear: (key) => set((state) => {
    if (state.texts[key] === undefined) return state;
    const next = { ...state.texts };
    delete next[key];
    return { texts: next };
  }),
}));
