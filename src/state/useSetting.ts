import { useEffect, useState } from 'react';
import { db } from '../core/storage/db';

/**
 * 設定的值只留一份（模組層快取），任何一處改都通知全部訂閱者。
 *
 * 為什麼非這樣不可：原本每個 `useSetting()` 呼叫點各自一個 `useState`，
 * AppShell（負責把 `--dsh-fs` 寫進 CSS 變數）與設定頁（負責那排「小/中/大/特大」按鈕）
 * 是兩份互不知情的狀態——在設定頁點字級，AppShell 那一份永遠不知道，
 * 使用者看到的就是「字級設定沒生效」。同理，同步換庫之後快取也必須整個重讀。
 */
interface CacheEntry { value: string; loaded: boolean }

/** null = 這個值作廢了（換庫 / 恢復預設），請重新從資料庫讀一次 */
type Listener = (value: string | null) => void;

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<Listener>>();

function emit(key: string, value: string | null): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of Array.from(set)) listener(value);
}

async function readFromDb(key: string, fallback: string): Promise<string> {
  const row = await db.settings.get(key).catch(() => undefined);
  return row?.value ?? fallback;
}

/**
 * 帳號換庫（登入 / 登出 / 刪除帳號）或「恢復預設設定」之後呼叫：
 * 快取裡是上一個狀態的值，全部作廢並通知訂閱者重讀。
 */
export function resetSettingCache(): void {
  cache.clear();
  listeners.forEach((_set, key) => emit(key, null));
}

export function useSetting(key: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => cache.get(key)?.value ?? fallback);

  useEffect(() => {
    let alive = true;
    const listener: Listener = (next) => {
      if (next !== null) {
        setValue(next);
        return;
      }
      void readFromDb(key, fallback).then((fresh) => {
        if (!alive) return;
        cache.set(key, { value: fresh, loaded: true });
        setValue(fresh);
      });
    };

    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);

    const cached = cache.get(key);
    if (cached?.loaded) {
      setValue(cached.value);
    } else {
      void readFromDb(key, fallback).then((fresh) => {
        if (!alive) return;
        cache.set(key, { value: fresh, loaded: true });
        emit(key, fresh);
      });
    }

    return () => {
      alive = false;
      set.delete(listener);
    };
  }, [key, fallback]);

  const update = (v: string) => {
    cache.set(key, { value: v, loaded: true });
    emit(key, v);
    void db.settings.put({ key, value: v });
  };

  return [value, update];
}

/** 讀布林值設定（存 '1' / '0'，與載入用字串的 settings 表一致） */
export function useSettingFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [raw, setRaw] = useSetting(key, fallback ? '1' : '0');
  const flag = raw !== '0' && raw !== 'false' && raw !== '';
  return [flag, (v: boolean) => setRaw(v ? '1' : '0')];
}
