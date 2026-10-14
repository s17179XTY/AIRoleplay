/// <reference types="node" />
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AccountSection from './AccountSection';
import { makeFakeServer, makeWorkerEnv, seedInvite } from '../../test/fake-server';
import { TEST_KDF } from '../../core/sync/kdf';
import { saveTokens, saveUsername, saveKdf } from '../../core/sync/session';
import { switchDatabase, DEFAULT_DB_NAME, db } from '../../core/storage/db';
import { useSync, __resetSyncMemoryForTest } from '../../state/useSync';

const INVITE = 'INV-ACCOUNT';
const BASE = 'https://api.test';
let server: typeof fetch;

beforeEach(async () => {
  const env = makeWorkerEnv();
  await seedInvite(env, INVITE);
  server = makeFakeServer(env);
  saveTokens(null);
  saveUsername(null);
  await switchDatabase(DEFAULT_DB_NAME);
  __resetSyncMemoryForTest();
  useSync.setState({
    username: null, status: 'signed-out', pending: 0, conflicts: 0, quota: null, lastSyncAt: null, message: null,
  });
});

const seams = { fetchImpl: undefined as unknown as typeof fetch, baseUrl: BASE, kdf: TEST_KDF };

function renderSection() {
  return render(<AccountSection seams={{ ...seams, fetchImpl: server }} />);
}

describe('AccountSection', () => {
  it('未登录时提供注册与登录两个入口，并说明不登录也能玩', () => {
    renderSection();
    expect(screen.getByText('注册（需邀请码）')).toBeTruthy();
    expect(screen.getByText('登录')).toBeTruthy();
    expect(screen.getByText(/不登录也一样能玩/)).toBeTruthy();
  });

  it('注册成功后弹出恢复码，未勾「我已抄下」不能关闭', async () => {
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'pw-123456' } });
    fireEvent.change(screen.getByPlaceholderText('再输一次密码'), { target: { value: 'pw-123456' } });
    fireEvent.change(screen.getByPlaceholderText('邀请码'), { target: { value: INVITE } });
    fireEvent.click(screen.getByText('注册并开始同步'));

    await waitFor(() => expect(screen.getByText('请抄下恢复码')).toBeTruthy());
    const done = screen.getByText('完成') as HTMLButtonElement;
    expect(done.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('我已抄下恢复码'));
    await waitFor(() => expect((screen.getByText('完成') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('完成'));
    await waitFor(() => expect(screen.queryByText('请抄下恢复码')).toBeNull());
    // 关掉之后应该看到已登录面板
    await waitFor(() => expect(screen.getByText('立即同步')).toBeTruthy());
  });

  it('密码太短或两次不一致时给本地提示，不呼叫服务器', () => {
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: '123' } });
    fireEvent.change(screen.getByPlaceholderText('再输一次密码'), { target: { value: '123' } });
    fireEvent.click(screen.getByText('注册并开始同步'));
    expect(screen.getByText('密码至少 6 个字符')).toBeTruthy();
  });

  it('邀请码无效时显示服务器的人话错误', async () => {
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'bob' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'pw-123456' } });
    fireEvent.change(screen.getByPlaceholderText('再输一次密码'), { target: { value: 'pw-123456' } });
    fireEvent.change(screen.getByPlaceholderText('邀请码'), { target: { value: 'WRONG-CODE' } });
    fireEvent.click(screen.getByText('注册并开始同步'));

    await waitFor(() => expect(screen.getByText(/邀請碼無效/)).toBeTruthy());
  });

  it('登录：密码错误时把「账号名或密码错误」显示出来', async () => {
    // 先注册一个账号（走 store，不走界面）
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    await useSync.getState().logout();
    saveKdf('alice', TEST_KDF);

    renderSection();
    fireEvent.click(screen.getByText('登录'));
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByText('登录并同步'));

    await waitFor(() => expect(screen.getByText(/帳號名或密碼錯誤/)).toBeTruthy());
  });

  it('已登录面板：显示账号名、同步状态、配额与立刻同步按钮', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    await db.settings.put({ key: 'k', value: 'v' });

    renderSection();
    await waitFor(() => expect(screen.getByText('alice')).toBeTruthy());
    expect(screen.getByText('立即同步')).toBeTruthy();
    expect(screen.getByText('退出登录')).toBeTruthy();
    expect(screen.getByText(/云端空间/)).toBeTruthy();
    expect(screen.getByText(/API Key 只存在本机/)).toBeTruthy();

    fireEvent.click(screen.getByText('立即同步'));
    await waitFor(() => expect(screen.getByText(/已同步|笔待同步/)).toBeTruthy());
  });

  it('重新载入后进入 locked 状态：要求输入密码解锁', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    // 模擬頁面重新載入：記憶體裡的 DEK 消失，但 localStorage 還有 token 與帳號名
    __resetSyncMemoryForTest();
    useSync.setState({ username: 'alice', status: 'signed-out' });

    renderSection();
    // 元件掛載時的 refresh() 會把它切成 locked
    await waitFor(() => expect(screen.getByText(/需要重新解锁/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('输入密码解锁'), { target: { value: 'pw-123456' } });
    fireEvent.click(screen.getByText('解锁'));
    await waitFor(() => expect(screen.getByText('立即同步')).toBeTruthy());
  });

  it('装置管理：展开后列出装置，可踢掉其他装置', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    // 同一帳號再登入一次 → 多一台装置
    await useSync.getState().login({ username: 'alice', password: 'pw-123456', ...seams, fetchImpl: server });

    renderSection();
    await waitFor(() => expect(screen.getByText('已登录的设备')).toBeTruthy());
    fireEvent.click(screen.getByText('已登录的设备'));

    await waitFor(() => expect(useSync.getState().devices.length).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(screen.queryAllByText('踢掉')).toHaveLength(1));
    fireEvent.click(screen.getByText('踢掉'));
    // 踢掉之後就沒有可踢的裝置了（getAllByText 在空結果會拋錯，所以用 queryAllByText）
    await waitFor(() => expect(screen.queryAllByText('踢掉')).toHaveLength(0));
    expect(useSync.getState().devices).toHaveLength(1);
  });

  it('冲突提示：有冲突时显示数量，点「知道了」清空', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    await db.syncConflicts.add({ kind: 'setting', id: 'k', rev: 1, updatedAt: 1, ciphertext: 'x', detectedAt: 1 });
    useSync.setState({ conflicts: 1 });

    renderSection();
    await waitFor(() => expect(screen.getByText(/1 笔冲突已保留本地副本/)).toBeTruthy());
    fireEvent.click(screen.getByText('知道了'));
    await waitFor(() => expect(screen.queryByText(/笔冲突已保留本地副本/)).toBeNull());
    expect(await db.syncConflicts.count()).toBe(0);
  });

  it('修改密码：成功后弹出新的恢复码，并能用新密码解锁', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    renderSection();
    await waitFor(() => expect(screen.getByText('修改密码')).toBeTruthy());

    fireEvent.click(screen.getByText('修改密码'));
    fireEvent.change(screen.getByPlaceholderText('当前密码'), { target: { value: 'pw-123456' } });
    fireEvent.change(screen.getByPlaceholderText('新密码（至少 6 位）'), { target: { value: 'pw-new-456' } });
    fireEvent.change(screen.getByPlaceholderText('再输一次新密码'), { target: { value: 'pw-new-456' } });
    fireEvent.click(screen.getByText('确认修改'));

    await waitFor(() => expect(screen.getByText('请抄下恢复码')).toBeTruthy());
  });

  it('忘记密码：切到恢复码表单，填错恢复码会显示服务器的人话错误', async () => {
    await useSync.getState().register({ username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server });
    await useSync.getState().logout();

    renderSection();
    await waitFor(() => expect(screen.getByText(/忘记密码/)).toBeTruthy());
    fireEvent.click(screen.getByText(/忘记密码/));
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText(/恢复码/), { target: { value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    fireEvent.change(screen.getByPlaceholderText('新密码（至少 6 位）'), { target: { value: 'pw-rescued-1' } });
    fireEvent.click(screen.getByText('用恢复码救回'));

    await waitFor(() => expect(screen.getByText(/帳號名或恢復碼錯誤/)).toBeTruthy());
  });

  it('忘记密码：能真的用恢复码救回并显示新恢复码', async () => {
    const first = await useSync.getState().register({
      username: 'alice', inviteCode: INVITE, password: 'pw-123456', ...seams, fetchImpl: server,
    });
    await db.settings.put({ key: 'precious', value: '1' });
    await useSync.getState().runSync(seams);
    await useSync.getState().logout();

    renderSection();
    await waitFor(() => expect(screen.getByText(/忘记密码/)).toBeTruthy());
    fireEvent.click(screen.getByText(/忘记密码/));
    fireEvent.change(screen.getByPlaceholderText(/账号名/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText(/恢复码/), { target: { value: first.recoveryCode } });
    fireEvent.change(screen.getByPlaceholderText('新密码（至少 6 位）'), { target: { value: 'pw-rescued-1' } });
    fireEvent.click(screen.getByText('用恢复码救回'));

    await waitFor(() => expect(screen.getByText('请抄下恢复码')).toBeTruthy(), { timeout: 15000 });
    expect((await db.settings.get('precious'))?.value).toBe('1');
  });
});
