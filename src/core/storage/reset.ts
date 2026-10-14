import { db } from './db';
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
 * 清空本機所有資料（包含同步用的 outbox / 游標 / 版本紀錄）。
 *
 * 注意：`clear()` 在 outbox 收斂點裡刻意不產生墓碑（見 core/sync/outbox.ts 的已知限制），
 * 所以這裡不會把「刪除」推上雲——雲端那份要另外用 DELETE /api/account 處理。
 */
export async function clearLocalData(): Promise<void> {
  const tables = db.tables.map((t) => t.name);
  await db.transaction('rw', tables.map((n) => db.table(n)), async () => {
    for (const table of db.tables) await table.clear();
  });
}
