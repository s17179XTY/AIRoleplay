import { db, currentDbName, DEFAULT_DB_NAME, type DshDB } from './db';
import { saveCardPackage } from './cardRepo';
import { seedPackage } from './seedPackage';

/** 記憶托管開關（settings 表）。'0' = 關，其餘視為開。 */
export const MEMORY_ENABLED_KEY = 'memoryEnabled';
export const FONT_SCALE_KEY = 'fontScale';

/**
 * 「恢復預設設定」時**必須保留**的設定鍵：服務商與模型配置是使用者自己接的，
 * 不屬於「預設設定」——按了恢復不該把 API Key 與模型一起清掉。
 */
export const PROVIDER_SETTING_KEYS = ['activeProviderId', 'activePresetId'];

export interface ResetSettingsResult {
  configs: number;
  settings: number;
}

/**
 * 恢復預設設定：
 * - 刪掉 global 這一份 configs（記憶條數 / 提示詞 / 前置詞 / 後置詞）→ 回到程式預設值；
 * - 清掉 settings 表，但**保留** activeProviderId / activePresetId（模型選擇）。
 *
 * 不動的：服務商、模型配置、卡片、對話、訊息、記憶庫、正則腳本。
 * 卡片自帶的 prompt 屬於卡片資料，也不在此列。
 */
export async function resetSettings(): Promise<ResetSettingsResult> {
  const globals = await db.configs.where('scope').equals('global').toArray();
  const settings = await db.settings.toArray();
  const doomed = settings.filter((row) => !PROVIDER_SETTING_KEYS.includes(row.key));
  await db.transaction('rw', [db.configs, db.settings], async () => {
    await db.configs.bulkDelete(globals.map((c) => c.id));
    await db.settings.bulkDelete(doomed.map((r) => r.key));
  });
  return { configs: globals.length, settings: doomed.length };
}

/** 恢復內置示範卡：無條件用目前的卡片包覆蓋（版本升級時也走同一條路） */
export async function resetDefaultCards(): Promise<string> {
  return saveCardPackage(seedPackage());
}

/** 目前這個庫裡有幾張卡片、幾個對話——給確認對話框顯示的 */
export async function localDataSummary(): Promise<{ cards: number; chats: number; messages: number; memories: number }> {
  return {
    cards: await db.cards.count(),
    chats: await db.chats.count(),
    messages: await db.messages.count(),
    memories: await db.memories.count(),
  };
}

/**
 * 清空**指定庫**的所有表（包含同步用的 outbox / 游標 / 版本紀錄）。
 *
 * 注意：clear() 在 outbox 收斂點裡刻意不產生墓碑（見 core/sync/outbox.ts 的已知限制），
 * 所以這裡不會把「刪除」推上雲——雲端那份要另外用 DELETE /api/account 處理。
 *
 * target 參數是給「換庫前把匿名庫清掉」「刪帳號後把預設庫也清掉」用的：
 * 那時 live binding 的 db 可能已經是另一個連線了。
 */
export async function clearLocalData(target: DshDB = db): Promise<void> {
  const tables = target.tables.map((t) => t.name);
  await target.transaction('rw', tables.map((n) => target.table(n)), async () => {
    for (const table of target.tables) await table.clear();
  });
}

/** 這是不是本程式的 IndexedDB（預設庫或帳號庫 dsh-roleplay@xxx） */
export function isOurDatabaseName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === DEFAULT_DB_NAME || name.startsWith(DEFAULT_DB_NAME + '@');
}

/**
 * 列出這台裝置上屬於本程式的所有 IndexedDB 名稱。
 *
 * 為什麼要列舉：帳號是「一帳號一庫」（dsh-roleplay@alice），
 * 舊版「清空本機所有資料」只清了目前那個庫，其它帳號庫與未登入的預設庫全都還留著，
 * 使用者換過帳號再清就會覺得「怎麼清都清不乾淨」。
 * indexedDB.databases() 在 Chrome/Edge/Safari 都支援；不支援的環境至少清目前庫＋預設庫。
 */
export async function listLocalDatabaseNames(): Promise<string[]> {
  const names = new Set<string>([DEFAULT_DB_NAME, currentDbName()]);
  // 不支援 indexedDB.databases() 的環境（舊 iOS / WebView）：用 localStorage 記過的帳號名推回帳號庫名
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key || !key.startsWith('dsh-sync-kdf:')) continue;
        const account = key.slice('dsh-sync-kdf:'.length).trim().toLowerCase();
        if (account) names.add(DEFAULT_DB_NAME + '@' + account);
      }
      const remembered = storage.getItem('dsh-sync-user');
      if (remembered) names.add(DEFAULT_DB_NAME + '@' + remembered.trim().toLowerCase());
    }
  } catch {
    // 隱私模式：拿不到就只清目前庫＋預設庫
  }
  const factory = globalThis.indexedDB as (IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }) | undefined;
  if (typeof factory?.databases === 'function') {
    try {
      const all = await factory.databases();
      for (const info of all) {
        if (isOurDatabaseName(info.name)) names.add(info.name as string);
      }
    } catch {
      // 列舉失敗就用「目前庫＋預設庫」保底
    }
  }
  return [...names].filter(isOurDatabaseName);
}

/** 清掉登入狀態（token / 帳號名 / 記住的 KDF）——只動本程式的鍵，不碰別的網站資料 */
export function clearSyncStorage(): string[] {
  const removed: string[] = [];
  try {
    const storage = globalThis.localStorage;
    if (!storage) return removed;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (!key.startsWith('dsh-sync-')) continue;
      storage.removeItem(key);
      removed.push(key);
    }
  } catch {
    // 隱私模式：localStorage 可能不能列舉
  }
  return removed;
}

export function deleteLocalDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = globalThis.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export interface WipeLocalResult {
  /** 真的刪掉的 IndexedDB 名稱 */
  databases: string[];
  /** 被其它分頁/視窗占用、刪不掉的 IndexedDB（不能當成功！） */
  failed: string[];
  /** 真的清掉的 localStorage 鍵 */
  storageKeys: string[];
}

/**
 * 真的「清空本機所有資料」：
 * 1. 刪掉本程式在這台裝置上的**所有** IndexedDB（dsh-roleplay 與所有 dsh-roleplay@帳號）；
 * 2. 清掉登入狀態（localStorage 的 dsh-sync-*）。
 *
 * 呼叫端（設定頁）負責重置模組快取並重新載入頁面。
 * 雲端資料不受影響——之後重新登入會從雲端同步回來（確認框要寫清楚）。
 */
export async function wipeAllLocalData(): Promise<WipeLocalResult> {
  const databases = await listLocalDatabaseNames();
  // 一定要先關掉目前連線，否則 deleteDatabase 會一直 blocked
  try {
    db.close();
  } catch {
    // ignore
  }
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const name of databases) {
    if (await deleteLocalDatabase(name)) deleted.push(name);
    else failed.push(name);
  }
  /*
   * 有庫被其它分頁/視窗占用而刪不掉時，**絕對不能**把登入 token 清掉還回報成功：
   * 使用者會變成「未登入但舊帳號資料還在」，下次登入同一帳號又看到那些資料——就是「清不乾淨」。
   * 保留登入狀態、把失敗清單回給 UI，請使用者關掉其它分頁再試一次。
   */
  if (failed.length > 0) return { databases: deleted, failed, storageKeys: [] };
  const storageKeys = clearSyncStorage();
  return { databases: deleted, failed, storageKeys };
}