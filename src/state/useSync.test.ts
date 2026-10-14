/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { useSync } from './useSync';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../test/fake-server';
import { loadTokens, saveKdf, saveTokens, saveUsername } from '../core/sync/session';
import { currentDbName, db, DEFAULT_DB_NAME, switchDatabase } from '../core/storage/db';
import { TEST_KDF } from '../core/sync/kdf';

const INVITE = 'INV-UI';
const BASE = 'https://api.test';
let server: typeof fetch;

beforeEach(async () => {
  const env = makeWorkerEnv();
  await seedInvite(env, INVITE);
  server = makeFakeServer(env);
  saveTokens(null);
  saveUsername(null);
  await switchDatabase(DEFAULT_DB_NAME);
  useSync.setState({
    username: null, status: 'signed-out', pending: 0, conflicts: 0, quota: null, lastSyncAt: null, message: null,
  });
});

const seams = () => ({ fetchImpl: server, baseUrl: BASE, kdf: TEST_KDF });

describe('useSync', () => {
  it('refresh：沒有 token 時是未登入', () => {
    useSync.getState().refresh();
    expect(useSync.getState().status).toBe('signed-out');
    expect(useSync.getState().username).toBeNull();
  });

  it('register：回傳恢復碼、切到帳號專屬的庫、狀態變 idle', async () => {
    const out = await useSync.getState().register({ username: 'Alice', inviteCode: INVITE, password: 'pw-123', ...seams() });

    expect(out.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(useSync.getState().username).toBe('alice');
    expect(useSync.getState().status).toBe('idle');
    expect(currentDbName()).toBe('dsh-roleplay@alice');
    expect(loadTokens()?.accessToken).toBeTruthy();
  });

  it('register：未登入期間的本地資料會被帶進新帳號庫（匿名庫認領）', async () => {
    await db.settings.put({ key: 'before', value: '1' });
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    expect((await db.settings.get('before'))?.value).toBe('1');
  });

  it('register：帳號名重複時狀態變 error 並給人話', async () => {
    const env = makeWorkerEnv();
    await seedInvite(env, 'INV-1');
    await seedInvite(env, 'INV-2');
    server = makeFakeServer(env);

    await useSync.getState().register({ username: 'alice', inviteCode: 'INV-1', password: 'pw-1', ...seams() });
    await useSync.getState().logout();

    await expect(
      useSync.getState().register({ username: 'alice', inviteCode: 'INV-2', password: 'pw-2', ...seams() }),
    ).rejects.toThrow();
    expect(useSync.getState().status).toBe('error');
    expect(useSync.getState().message).toContain('帳號名');
  });

  it('runSync：pending 歸零、quota 與 lastSyncAt 有值', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    await db.settings.put({ key: 'k', value: 'v' });
    expect(await useSync.getState().pending).toBe(0); // 剛 register 完已經同步過
    await useSync.getState().runSync(seams());
    expect(useSync.getState().pending).toBe(0);
    expect(useSync.getState().quota?.limit).toBeGreaterThan(0);
    expect(useSync.getState().lastSyncAt).toBeGreaterThan(0);
    expect(useSync.getState().status).toBe('idle');
  });

  it('logout：清 token、切回預設庫、帳號庫留在裝置上', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    await db.settings.put({ key: 'keep', value: '1' });

    await useSync.getState().logout();

    expect(useSync.getState().status).toBe('signed-out');
    expect(useSync.getState().username).toBeNull();
    expect(loadTokens()).toBeNull();
    expect(currentDbName()).toBe(DEFAULT_DB_NAME);

    await switchDatabase('dsh-roleplay@alice');
    expect((await db.settings.get('keep'))?.value).toBe('1');
  });

  it('重新載入頁面後（有 token 但沒有 DEK）是 locked，輸入密碼可解鎖', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    // 模擬重新載入：模組記憶體裡的 DEK 沒了
    const moduleState = useSync.getState();
    useSync.setState({ ...moduleState, status: 'signed-out' });
    const { __resetSyncMemoryForTest } = await import('./useSync');
    __resetSyncMemoryForTest();

    useSync.getState().refresh();
    expect(useSync.getState().status).toBe('locked');
    expect(useSync.getState().username).toBe('alice');

    await useSync.getState().unlock('pw-123', seams());
    expect(useSync.getState().status).toBe('idle');
    expect(currentDbName()).toBe('dsh-roleplay@alice');
  });

  it('login：換一台裝置（新庫）能用同一組密碼登入並解出同一把 DEK', async () => {
    const first = await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    expect(first.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    await db.settings.put({ key: 'fromA', value: 'A' });
    await useSync.getState().runSync(seams());
    await useSync.getState().logout();

    // 新裝置：資料庫是空的
    await switchDatabase(`dsh-roleplay@alice-fresh-${Math.random().toString(36).slice(2)}`);

    await useSync.getState().login({ username: 'alice', password: 'pw-123', ...seams() });
    expect(useSync.getState().status).toBe('idle');
    expect(currentDbName()).toBe('dsh-roleplay@alice');
    expect((await db.settings.get('fromA'))?.value).toBe('A'); // 拉回來了
  });

  it('login：密碼錯時狀態變 error，不影響本地可用性', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', ...seams() });
    await useSync.getState().logout();
    saveKdf('alice', TEST_KDF);
    await expect(useSync.getState().login({ username: 'alice', password: 'wrong', ...seams() })).rejects.toThrow();
    expect(useSync.getState().status).toBe('error');
    expect(useSync.getState().message).toContain('帳號名或密碼');
  });

  it('沒有設定後端位址時給出明確訊息（不是靜靜失敗）', async () => {
    await expect(
      useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123', fetchImpl: server, kdf: TEST_KDF, baseUrl: '' }),
    ).rejects.toThrow('VITE_SYNC_API');
    expect(useSync.getState().message).toContain('沒有設定同步後端');
  });
});
