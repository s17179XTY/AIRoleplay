import { create } from 'zustand';
import { createSyncClient, type DeviceInfo, type SyncClient } from '../core/sync/client';
import {
  loadKdf, loadTokens, loadUsername, saveKdf, saveTokens, saveUsername, syncApiBaseUrl,
} from '../core/sync/session';
import {
  deriveAuthKey, deriveMasterKey, deriveRecoveryAuthKey, deriveRecoveryKey,
  generateRecoveryCode, PROD_KDF, type KdfParams,
} from '../core/sync/kdf';
import { generateDek, unwrapDek, wrapDek } from '../core/sync/envelope';
import { initialPush, syncNow, type EngineContext } from '../core/sync/engine';
import { pendingCount } from '../core/sync/outbox';
import { LOCAL_ONLY_TABLES } from '../core/sync/kinds';
import { db, switchDatabase, dbNameFor, DEFAULT_DB_NAME, type DshDB } from '../core/storage/db';

export type SyncStatus = 'signed-out' | 'locked' | 'idle' | 'syncing' | 'error';

export interface SyncUiState {
  username: string | null;
  status: SyncStatus;
  pending: number;
  conflicts: number;
  quota: { used: number; limit: number } | null;
  lastSyncAt: number | null;
  message: string | null;
  devices: DeviceInfo[];
}

/** 測試用的接縫：讓測試注入假伺服器、假 baseUrl 與低成本 KDF */
export interface SyncSeams {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  kdf?: KdfParams;
}

export interface SyncActions {
  /** App 啟動時呼叫：有 token 但沒有 DEK（重新載入頁面）→ locked，要求輸入密碼解鎖 */
  refresh(): void;
  register(input: { username: string; inviteCode: string; password: string } & SyncSeams): Promise<{ recoveryCode: string }>;
  login(input: { username: string; password: string } & SyncSeams): Promise<void>;
  unlock(password: string, seams?: SyncSeams): Promise<void>;
  logout(): Promise<void>;
  runSync(seams?: SyncSeams): Promise<void>;
  loadDevices(seams?: SyncSeams): Promise<void>;
  revokeDevice(id: string, seams?: SyncSeams): Promise<void>;
  dismissConflicts(): Promise<void>;
}

const INITIAL: SyncUiState = {
  username: null,
  status: 'signed-out',
  pending: 0,
  conflicts: 0,
  quota: null,
  lastSyncAt: null,
  message: null,
  devices: [],
};

/** DEK 只存在記憶體：重新載入頁面後必須重新輸入密碼解鎖（spec §9） */
let currentDek: CryptoKey | null = null;
let deviceId: string | null = null;

function currentDeviceId(): string {
  if (!deviceId) deviceId = `dev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return deviceId;
}

function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return ua ? ua.slice(0, 60) : 'device';
}

function makeClient(seams: SyncSeams = {}): SyncClient {
  const baseUrl = seams.baseUrl ?? syncApiBaseUrl();
  if (!baseUrl) throw new Error('這個版本沒有設定同步後端（VITE_SYNC_API）');
  return createSyncClient({
    baseUrl,
    fetchImpl: seams.fetchImpl,
    getTokens: loadTokens,
    onTokens: saveTokens,
  });
}

function context(client: SyncClient, database: DshDB = db): EngineContext {
  if (!currentDek) throw new Error('尚未解鎖，請輸入密碼');
  return { db: database, client, dek: currentDek, deviceId: currentDeviceId() };
}

/**
 * 首次註冊：把未登入期間累積的本地資料整批帶進帳號專屬的庫（單向認領）。
 * 一定要**先讀完再換庫**——switchDatabase 會把舊連線關掉，關掉之後就讀不到了。
 */
async function snapshotAnonymousData(source: DshDB): Promise<Array<{ name: string; rows: unknown[] }>> {
  const snapshot: Array<{ name: string; rows: unknown[] }> = [];
  for (const table of source.tables) {
    if (LOCAL_ONLY_TABLES.includes(table.name)) continue;
    const rows = await source.table(table.name).toArray();
    if (rows.length > 0) snapshot.push({ name: table.name, rows });
  }
  return snapshot;
}

async function writeSnapshot(target: DshDB, snapshot: Array<{ name: string; rows: unknown[] }>): Promise<void> {
  for (const { name, rows } of snapshot) {
    await target.table(name).bulkPut(rows as never);
  }
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('VITE_SYNC_API')) return '這個版本沒有設定同步後端';
  if (raw.includes('Failed to fetch') || raw.includes('NetworkError')) return '連不上伺服器，請稍後重試';
  return raw;
}

/** 測試用：模擬「頁面重新載入」——模組記憶體裡的 DEK 與 deviceId 都會消失 */
export function __resetSyncMemoryForTest(): void {
  currentDek = null;
  deviceId = null;
}

export const useSync = create<SyncUiState & SyncActions>((set, get) => ({
  ...INITIAL,

  refresh() {
    const tokens = loadTokens();
    const username = loadUsername();
    if (!tokens || !username) {
      set({ ...INITIAL });
      return;
    }
    // token 還在但 DEK 只在記憶體裡 → 需要解鎖
    set({ username, status: currentDek ? get().status : 'locked', message: null });
  },

  async register({ username, inviteCode, password, ...seams }) {
    const name = username.trim().toLowerCase();
    const kdf = seams.kdf ?? PROD_KDF;
    try {
      const client = makeClient(seams);
      const authKey = await deriveAuthKey(password, name, kdf);
      const masterKey = await deriveMasterKey(password, name, kdf);
      const dek = await generateDek();
      const wrappedDek = await wrapDek(dek, masterKey);
      const recoveryCode = generateRecoveryCode();

      const anonymous = db;
      await client.register({
        username: name,
        inviteCode,
        authKey,
        kdf: JSON.stringify(kdf),
        wrappedDek,
        recoveryAuthKey: await deriveRecoveryAuthKey(recoveryCode, name),
        recoveryWrappedDek: await wrapDek(dek, await deriveRecoveryKey(recoveryCode, name)),
        label: deviceLabel(),
      });

      saveUsername(name);
      saveKdf(name, kdf);
      currentDek = dek;

      const snapshot = await snapshotAnonymousData(anonymous);
      const account = await switchDatabase(dbNameFor(name));
      await writeSnapshot(account, snapshot);
      await initialPush(context(client, account));
      set({ username: name, status: 'idle', message: null });
      await get().runSync(seams);
      return { recoveryCode };
    } catch (err) {
      set({ status: 'error', message: errorMessage(err) });
      throw err;
    }
  },

  async login({ username, password, ...seams }) {
    const name = username.trim().toLowerCase();
    // 先試本機記住的 KDF 參數，沒記錄就用目前的預設值
    const kdf = seams.kdf ?? loadKdf(name) ?? PROD_KDF;
    try {
      const client = makeClient(seams);
      await client.login({ username: name, authKey: await deriveAuthKey(password, name, kdf), label: deviceLabel() });

      const me = await client.me();
      const serverKdf = JSON.parse(me.kdf) as KdfParams;
      const masterKey = await deriveMasterKey(password, name, serverKdf);
      currentDek = await unwrapDek(me.wrappedDek, masterKey);

      saveUsername(name);
      saveKdf(name, serverKdf);
      await switchDatabase(dbNameFor(name));
      set({ username: name, status: 'idle', message: null });
      await get().runSync(seams);
    } catch (err) {
      set({ status: 'error', message: errorMessage(err) });
      throw err;
    }
  },

  async unlock(password, seams = {}) {
    const name = get().username ?? loadUsername();
    if (!name) {
      set({ ...INITIAL });
      return;
    }
    await get().login({ username: name, password, ...seams });
  },

  async logout() {
    try {
      const client = makeClient({});
      await client.logout();
    } catch {
      // 連不上、或這個版本根本沒設後端：一樣要把本地登入狀態清掉（否則等於登出失敗）
      saveTokens(null);
    }
    currentDek = null;
    saveUsername(null);
    await switchDatabase(DEFAULT_DB_NAME);
    set({ ...INITIAL });
  },

  async runSync(seams = {}) {
    const username = get().username;
    if (!username || !currentDek) return;
    set({ status: 'syncing', message: null });
    try {
      const client = makeClient(seams);
      const result = await syncNow(context(client));
      const conflicts = await db.syncConflicts.count();
      const quotaUsed = await db.syncState.get('quotaUsed');
      const quotaLimit = await db.syncState.get('quotaLimit');
      const lastSyncAt = await db.syncState.get('lastSyncAt');
      set({
        status: 'idle',
        pending: await pendingCount(),
        conflicts,
        quota: quotaLimit ? { used: Number(quotaUsed?.value ?? 0), limit: Number(quotaLimit.value) } : get().quota,
        lastSyncAt: lastSyncAt ? Number(lastSyncAt.value) : Date.now(),
        message: result.conflicts > 0 ? `${result.conflicts} 筆衝突已保留本地副本` : null,
      });
    } catch (err) {
      set({ status: 'error', message: errorMessage(err) });
    }
  },

  async loadDevices(seams = {}) {
    if (!get().username) return;
    try {
      const client = makeClient(seams);
      set({ devices: await client.devices() });
    } catch (err) {
      set({ message: errorMessage(err) });
    }
  },

  async revokeDevice(id, seams = {}) {
    try {
      const client = makeClient(seams);
      await client.revokeDevice(id);
      set({ devices: (await client.devices()).filter((d) => d.id !== id) });
    } catch (err) {
      set({ message: errorMessage(err) });
    }
  },

  async dismissConflicts() {
    await db.syncConflicts.clear();
    set({ conflicts: 0, message: null });
  },
}));
