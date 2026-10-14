import Dexie, { type Table } from 'dexie';
import type {
  AssetRecord, CardFileRecord, CardRecord, CardUiStateRecord, ChatRecord, ConfigRecord,
  MemoryRecord, MessageRecord, ModelPresetRecord, ProviderRecord, RegexScriptRecord,
  SettingRecord, WorldbookEntryRecord, WorldbookRecord,
} from './types';

/** 待推送佇列：主鍵是 [kind+id]，所以同一筆改十次也只留一筆 */
export interface OutboxRecord { kind: string; id: string; deleted: 0 | 1; queuedAt: number }
export interface SyncStateRecord { key: string; value: string }
/**
 * 每筆記錄已同步到第幾個版本。
 * 刻意**不放在記錄本身**（例如 row.__rev）：App 的正常寫入是整筆覆蓋，
 * 會把附加欄位一起抹掉，於是第二次推送就誤判成衝突。放獨立表就沒這問題。
 */
export interface SyncRevRecord { kind: string; id: string; rev: number }
export interface ConflictRecord {
  seq?: number; kind: string; id: string; rev: number; updatedAt: number; ciphertext: string; detectedAt: number;
}
export interface BlobStateRecord {
  blobId: string;
  /**
   * 這顆 blob 屬於哪一種記錄（`assetMeta` / `cardFile`）。
   * 沒有它就無法從 refId 反查回哪一張表——那會讓「剛同步完卡片頁/圖片是空的」永遠補不回來。
   */
  kind?: 'assetMeta' | 'cardFile';
  state: 'local' | 'uploaded' | 'remote';
  refId: string;
  size: number;
  /**
   * 用 DEK 包好的 fileKey（base64url）。
   * 必須持久化後重用：blobId 是內容定址，但密文取決於隨機 fileKey；
   * 重試時若換一把新鑰匙，先前已經推上雲的信封就永遠解不開。
   */
  fileKey?: string;
}

export const DEFAULT_DB_NAME = 'dsh-roleplay';

/** 帳號分庫：登入帳號各自一個 IndexedDB，未登入用預設庫 */
export function dbNameFor(username: string): string {
  return `${DEFAULT_DB_NAME}@${username.toLowerCase()}`;
}

export class DshDB extends Dexie {
  cards!: Table<CardRecord, string>;
  cardFiles!: Table<CardFileRecord, [string, string]>;
  assets!: Table<AssetRecord, string>;
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  memories!: Table<MemoryRecord, string>;
  worldbooks!: Table<WorldbookRecord, string>;
  worldbookEntries!: Table<WorldbookEntryRecord, string>;
  regexScripts!: Table<RegexScriptRecord, string>;
  providers!: Table<ProviderRecord, string>;
  modelPresets!: Table<ModelPresetRecord, string>;
  configs!: Table<ConfigRecord, string>;
  cardUiState!: Table<CardUiStateRecord, [string, string]>;
  settings!: Table<SettingRecord, string>;
  syncOutbox!: Table<OutboxRecord, [string, string]>;
  syncState!: Table<SyncStateRecord, string>;
  syncRev!: Table<SyncRevRecord, [string, string]>;
  syncConflicts!: Table<ConflictRecord, number>;
  blobState!: Table<BlobStateRecord, string>;

  constructor(name = DEFAULT_DB_NAME) {
    super(name);
    this.version(1).stores({
      cards: 'id, updatedAt, name, *tags',
      cardFiles: '[cardId+path], cardId, kind',
      assets: 'id',
      chats: 'id, cardId, updatedAt',
      messages: 'id, chatId, parentId, [chatId+createdAt]',
      memories: 'id, chatId, [chatId+tier]',
      worldbooks: 'id',
      worldbookEntries: 'id, worldbookId, *keys',
      regexScripts: 'id, scope, chatId',
      providers: 'id',
      modelPresets: 'id, providerId',
      configs: 'id, scope, refId',
      cardUiState: '[cardId+key]',
      settings: 'key',
    });
    this.version(2).stores({
      syncOutbox: '[kind+id], kind',
      syncState: 'key',
      syncRev: '[kind+id], kind',
      syncConflicts: '++seq, kind, id',
      blobState: 'blobId, state, refId',
    });
  }
}

let currentName = DEFAULT_DB_NAME;

/**
 * 建立資料庫實例的唯一入口。存在的理由是 Dexie 的 middleware（dbcore 堆疊）**必須在 open() 之前安裝**
 * 才生效——實測：open 之後才 `use()` 完全攔不到，連清 `_core` 都無效（只有 close → use → open 才會重建）。
 * 所以同步層透過 onDatabaseCreated 掛鉤，在這裡、實例剛建立、還沒被打開時就裝好。
 */
let createdHook: ((target: DshDB) => void) | null = null;

export function onDatabaseCreated(hook: (target: DshDB) => void): void {
  createdHook = hook;
}

function createDb(name: string): DshDB {
  const next = new DshDB(name);
  widenTransactionScope(next);
  createdHook?.(next);
  return next;
}

/**
 * 把 syncOutbox 併進每個讀寫交易的 store 範圍。
 *
 * 為什麼需要：IndexedDB 的交易範圍在建立時就固定，而 outbox 的唯一收斂點（Dexie middleware）
 * 必須在同一個交易裡補寫一筆 dirty 標記，否則會噴 NotFoundError（實測）。
 * `_createTransaction` 是 Dexie 的內部 API（實例屬性，自動交易與顯式交易都經過它），
 * 所以 outbox.ts 還留了一條 fallback：萬一這裡失效，就改用獨立交易補寫。
 */
function widenTransactionScope(target: DshDB): void {
  const internal = target as unknown as {
    _createTransaction?: (mode: string, storeNames: string[], schema: unknown, parent?: unknown) => unknown;
  };
  const original = internal._createTransaction;
  if (typeof original !== 'function') return;
  internal._createTransaction = function (
    this: unknown,
    mode: string,
    storeNames: string[],
    schema: unknown,
    parent?: unknown,
  ) {
    const names =
      mode === 'readwrite' && Array.isArray(storeNames) && !storeNames.includes('syncOutbox')
        ? [...storeNames, 'syncOutbox']
        : storeNames;
    return original.call(this, mode, names, schema, parent);
  };
}

/**
 * 目前的資料庫連線。這裡用 `let` + ESM live binding：全站 37 個 `db.xxx` 使用點都寫在函式體內，
 * 換庫之後它們讀到的就是新連線，不必改任何呼叫端。
 */
export let db = createDb(currentName);

export function currentDbName(): string {
  return currentName;
}

/** 換到指定名稱的庫（不關舊的；要關請用 switchDatabase） */
export function openDatabase(name: string): DshDB {
  currentName = name;
  const next = createDb(name);
  db = next;
  return next;
}

export async function switchDatabase(name: string): Promise<DshDB> {
  if (name === currentName) {
    await db.open();
    return db;
  }
  db.close();
  const next = openDatabase(name);
  await next.open();
  return next;
}

export function newId(prefix = ''): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g && typeof g.randomUUID === 'function') return prefix + g.randomUUID();
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
