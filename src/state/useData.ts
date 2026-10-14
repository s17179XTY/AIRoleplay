import { create } from 'zustand';

/**
 * 「本機資料被換掉了」的全域廣播。
 *
 * 需要它的場景有兩種，兩種都不會經過 React 的 state：
 * 1. 登入 / 登出 / 恢復碼救援會把整個 IndexedDB 連線換成帳號專屬的庫（見 `db.ts` 的帳號分庫）；
 * 2. 同步會把另一台裝置的變更套進本地。
 *
 * 少了這個訊號，畫面會一直停在換庫前的內容——使用者看到的就是
 * 「同步完 UI 沒更新，看起來像資料沒了」。
 */
export interface DataState {
  version: number;
  reason: string;
  bump: (reason?: string) => void;
}

export const useData = create<DataState>((set, get) => ({
  version: 0,
  reason: '',
  bump: (reason = '') => set({ version: get().version + 1, reason }),
}));

/** 給非 React 的呼叫端（store、同步引擎）用 */
export function bumpData(reason = ''): void {
  useData.getState().bump(reason);
}
