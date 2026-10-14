import Dexie, { type DBCoreMutateRequest, type DBCorePutRequest } from 'dexie';
import type { DshDB } from '../storage/db';
import { db as liveDb, onDatabaseCreated } from '../storage/db';
import { keyOf, SYNC_TABLES, type SyncKind } from './kinds';

export interface OutboxEntry {
  kind: SyncKind;
  id: string;
  deleted: 0 | 1;
  queuedAt: number;
}

const TABLE_BY_NAME = new Map<string, SyncKind>(
  Object.entries(SYNC_TABLES).map(([kind, table]) => [table, kind as SyncKind]),
);

/** 同步層自己套用遠端資料時設為 true，避免「套用遠端 → 產生本地變更 → 再推回去」的無限迴圈 */
let applyingRemote = false;
const installed = new WeakSet<DshDB>();

export function setApplyingRemote(flag: boolean): void {
  applyingRemote = flag;
}

function current(): DshDB {
  return liveDb;
}

export async function pendingCount(target: DshDB = current()): Promise<number> {
  return target.syncOutbox.count();
}

export async function takeOutbox(limit: number, target: DshDB = current()): Promise<OutboxEntry[]> {
  const rows = await target.syncOutbox.limit(limit).toArray();
  return rows as OutboxEntry[];
}

export async function clearOutbox(entries: OutboxEntry[], target: DshDB = current()): Promise<void> {
  const keys = entries.map((e) => [e.kind, e.id] as [string, string]);
  await target.syncOutbox.bulkDelete(keys);
}

/** Dexie 的 delete 傳進來的是主鍵：字串（單主鍵）或陣列（複合主鍵） */
function idsFromKeys(keys: unknown[]): string[] {
  return keys.map((key) => {
    if (Array.isArray(key)) return key.map(String).join(':');
    if (typeof key === 'string') return key;
    if (key && typeof key === 'object') {
      const composite = key as { cardId?: string; path?: string; key?: string };
      if (composite.cardId !== undefined) return `${composite.cardId}:${composite.path ?? composite.key ?? ''}`;
    }
    return String(key);
  });
}

/**
 * 唯一收斂點：用 Dexie 的 dbcore middleware 攔下所有寫入，順手把 (kind,id) 塞進 outbox。
 * 這樣 37 個既有的 db.xxx 使用點一行都不用改。
 *
 * **Dexie 的兩個陷阱（都實測過）**：
 * 1. dbcore 堆疊在 `open()` 時定版。open 之後才 `use()` 完全攔不到（連清 `_core` 都無效），
 *    只有「關庫 → use → 重開」才會重建。所以新實例一律走 onDatabaseCreated（實例剛建立、還沒 open）。
 * 2. IndexedDB 的交易範圍在建立時就固定。outbox 補寫必須在同一個交易裡，否則噴 NotFoundError，
 *    因此 db.ts 的 widenTransactionScope 會把 syncOutbox 併進每個讀寫交易的範圍；這裡另留 fallback。
 *
 * 已知限制：clear()／deleteRange 不產生 outbox（v1 不做「清空本地資料」的同步）。
 */
export async function installSyncTap(target: DshDB): Promise<void> {
  if (installed.has(target)) return;
  installed.add(target);

  const apply = (): void => {
    target.use({
      stack: 'dbcore',
      name: 'dsh-sync-outbox',
      create(downlevel) {
        const proxies = new Map<string, unknown>();
        return {
          ...downlevel,
          table(name: string) {
            const kind = TABLE_BY_NAME.get(name);
            const inner = downlevel.table(name);
            if (!kind) return inner;
            const cached = proxies.get(name);
            if (cached) return cached as typeof inner;

            let outbox: typeof inner | null = null;
            const proxy = new Proxy(inner, {
              get(tableTarget, prop, receiver) {
                if (prop !== 'mutate') {
                  const value = Reflect.get(tableTarget, prop, receiver);
                  return typeof value === 'function' ? value.bind(tableTarget) : value;
                }
                const original = Reflect.get(tableTarget, 'mutate', receiver) as (
                  req: DBCoreMutateRequest,
                ) => Promise<unknown>;
                return (req: DBCoreMutateRequest) => {
                  const result = original.call(tableTarget, req);
                  if (applyingRemote) return result;

                  const at = Date.now();
                  const entries: OutboxEntry[] = [];
                  if (req.type === 'put' || req.type === 'add') {
                    for (const value of req.values) {
                      if (!value || typeof value !== 'object') continue;
                      entries.push({ kind, id: keyOf(kind, value as Record<string, unknown>), deleted: 0, queuedAt: at });
                    }
                  } else if (req.type === 'delete') {
                    for (const id of idsFromKeys(req.keys)) entries.push({ kind, id, deleted: 1, queuedAt: at });
                  }
                  // deleteRange（也就是 clear()）刻意不處理：見上面的已知限制
                  if (entries.length === 0) return result;

                  outbox = outbox ?? downlevel.table('syncOutbox');
                  // 沿用同一個 req 的 trans，確保 outbox 與業務寫入在同一個交易裡
                  const writes = Promise.all(
                    entries.map((entry) => {
                      const writeReq: DBCorePutRequest = { type: 'put', trans: req.trans, values: [entry] };
                      return outbox!.mutate(writeReq) as Promise<unknown>;
                    }),
                  ).catch(async (err: unknown) => {
                    // 保底：Dexie 內部 API 若變動導致交易範圍沒被加寬，改用獨立交易補寫。
                    // 非原子，但至少不會讓整批寫入失敗、也不會漏掉 dirty 標記。
                    if ((err as { name?: string } | null)?.name === 'NotFoundError') {
                      await Dexie.ignoreTransaction(() => target.syncOutbox.bulkPut(entries as never));
                      return;
                    }
                    throw err;
                  });
                  return Promise.all([result, writes]).then((all) => all[0]);
                };
              },
            });
            proxies.set(name, proxy);
            return proxy as typeof inner;
          },
        } as unknown as typeof downlevel;
      },
    });
  };

  if (target.isOpen()) {
    target.close();
    apply();
    await target.open();
    return;
  }
  apply();
}

// 新建立的庫（登入換帳號、測試換庫）自動掛上收斂點。
onDatabaseCreated((target) => {
  void installSyncTap(target);
});
