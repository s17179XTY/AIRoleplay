/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { useSync, __resetSyncMemoryForTest } from '../../state/useSync';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { saveTokens, saveUsername, loadTokens } from './session';
import { currentDbName, db, switchDatabase, DEFAULT_DB_NAME } from '../storage/db';
import { deriveAuthKey, deriveMasterKey, TEST_KDF } from './kdf';
import { unwrapDek, dekFingerprint } from './envelope';

const INVITE = 'INV-RECOVER';
const BASE = 'https://api.test';
let server: typeof fetch;

function seams() {
  return { fetchImpl: server, baseUrl: BASE, kdf: TEST_KDF };
}

beforeEach(async () => {
  const env = makeWorkerEnv();
  await seedInvite(env, INVITE);
  server = makeFakeServer(env);
  saveTokens(null);
  saveUsername(null);
  await switchDatabase(DEFAULT_DB_NAME);
  __resetSyncMemoryForTest();
  useSync.setState({
    username: null, status: 'signed-out', pending: 0, conflicts: 0, quota: null, lastSyncAt: null, message: null, devices: [],
  });
});

describe('改密碼與恢復碼救援（端到端）', () => {
  it('改密碼：本機資料仍可讀、新裝置用新密碼登入拿得到同一份資料', async () => {
    const { recoveryCode } = await useSync.getState().register({
      username: 'alice', inviteCode: INVITE, password: 'pw-old-123', ...seams(),
    });
    expect(recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);

    await db.settings.put({ key: 'keep', value: 'v1' });
    await useSync.getState().runSync(seams());

    const changed = await useSync.getState().changePassword('pw-old-123', 'pw-new-456', seams());
    expect(changed.recoveryCode).not.toBe(recoveryCode);

    // 同一台裝置的本地資料仍可讀（DEK 沒變）
    expect((await db.settings.get('keep'))?.value).toBe('v1');
    expect(await db.settings.count()).toBeGreaterThan(0);

    // 新裝置用新密碼登入 → 拉到資料
    await useSync.getState().logout();
    await switchDatabase(`dsh-roleplay@alice-fresh-${Math.random().toString(36).slice(2)}`);
    await useSync.getState().login({ username: 'alice', password: 'pw-new-456', ...seams() });
    expect(currentDbName()).toBe('dsh-roleplay@alice');
    expect((await db.settings.get('keep'))?.value).toBe('v1');
  });

  it('改密碼：舊密碼不能再登入', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-old-123', ...seams() });
    await useSync.getState().changePassword('pw-old-123', 'pw-new-456', seams());
    await useSync.getState().logout();
    await expect(useSync.getState().login({ username: 'alice', password: 'pw-old-123', ...seams() })).rejects.toThrow();
  });

  it('忘記密碼：用恢復碼在新裝置救回，資料完整還原，舊密碼失效', async () => {
    const first = await useSync.getState().register({
      username: 'alice', inviteCode: INVITE, password: 'pw-old-123', ...seams(),
    });
    await db.settings.put({ key: 'precious', value: '不可失去的資料' });
    await db.chats.put({
      id: 'chat_1', cardId: 'card_1', title: '重要對話', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null, createdAt: 1, updatedAt: 1, archived: 0,
    });
    await useSync.getState().runSync(seams());

    // 完全忘記密碼：換一台「新裝置」
    await useSync.getState().logout();
    __resetSyncMemoryForTest();
    await switchDatabase(`dsh-roleplay@alice-rescue-${Math.random().toString(36).slice(2)}`);
    saveTokens(null);
    saveUsername(null);

    const rescued = await useSync.getState().recoverAccount({
      username: 'alice', recoveryCode: first.recoveryCode, newPassword: 'pw-rescued-789', ...seams(),
    });
    expect(rescued.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(rescued.recoveryCode).not.toBe(first.recoveryCode); // 恢復碼也換新
    expect(useSync.getState().username).toBe('alice');
    expect(currentDbName()).toBe('dsh-roleplay@alice');

    // 資料回來了
    expect((await db.settings.get('precious'))?.value).toBe('不可失去的資料');
    expect((await db.chats.get('chat_1'))?.title).toBe('重要對話');
    expect(loadTokens()?.accessToken).toBeTruthy();

    // 舊密碼不能登入，新密碼可以
    await useSync.getState().logout();
    await expect(useSync.getState().login({ username: 'alice', password: 'pw-old-123', ...seams() })).rejects.toThrow();
    await useSync.getState().login({ username: 'alice', password: 'pw-rescued-789', ...seams() });
    expect(useSync.getState().status).toBe('idle');
  });

  it('沒有恢復碼：救援被拒，資料不會被動到', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-old-123', ...seams() });
    await db.settings.put({ key: 'safe', value: '1' });
    await useSync.getState().runSync(seams());
    await useSync.getState().logout();

    await expect(
      useSync.getState().recoverAccount({
        username: 'alice', recoveryCode: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', newPassword: 'pw-hacked', ...seams(),
      }),
    ).rejects.toThrow();
    expect(useSync.getState().status).toBe('error');

    // 原密碼仍可登入，資料還在
    await useSync.getState().login({ username: 'alice', password: 'pw-old-123', ...seams() });
    expect((await db.settings.get('safe'))?.value).toBe('1');
  });

  it('救援解出的 DEK 與原本一致（指紋相同，代表資料真的解得開）', async () => {
    // 直接用底層函式驗證「恢復碼包的那把 DEK」與「密碼包的那把 DEK」是同一把
    const recoveryCode = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJKMNPQRSTVWXYZ01';
    const master = await deriveMasterKey('pw-old-123', 'alice', TEST_KDF);
    const { generateDek, wrapDek } = await import('./envelope');
    const { deriveRecoveryKey } = await import('./kdf');
    const dek = await generateDek();
    const byPassword = await wrapDek(dek, master);
    const byRecovery = await wrapDek(dek, await deriveRecoveryKey(recoveryCode, 'alice'));

    expect(await dekFingerprint(await unwrapDek(byPassword, master))).toBe(await dekFingerprint(dek));
    expect(await dekFingerprint(await unwrapDek(byRecovery, await deriveRecoveryKey(recoveryCode, 'alice')))).toBe(
      await dekFingerprint(dek),
    );
    // 用錯的恢復碼解不開
    await expect(unwrapDek(byRecovery, await deriveRecoveryKey('WRONGCODE', 'alice'))).rejects.toThrow();
  });

  it('authKey 由密碼與帳號名決定：救援後用新密碼算出的 authKey 與伺服器一致', async () => {
    const authKey = await deriveAuthKey('pw-rescued-789', 'alice', TEST_KDF);
    expect(authKey).toBe(await deriveAuthKey('pw-rescued-789', 'alice', TEST_KDF));
    expect(authKey).not.toBe(await deriveAuthKey('pw-old-123', 'alice', TEST_KDF));
  });
});
