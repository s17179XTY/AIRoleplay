import { useEffect, useState } from 'react';
import { useSync, type SyncSeams } from '../../state/useSync';
import { formatRecoveryCode } from '../../core/sync/kdf';
import { syncApiBaseUrl } from '../../core/sync/session';
import DevicesPanel from './DevicesPanel';
import ConflictPanel from './ConflictPanel';

const inputClass = 'w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0072E3]';

function formatTime(value: number | null): string {
  if (!value) return '还没同步过';
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * 设置页的「账号」分节。
 * 未登录时只是一个可选的入口——不挡任何玩法（见 AGENTS.md 的「本地优先」硬约束）。
 * seams 是给测试注入假服务器用的，正式渲染不传。
 */
export default function AccountSection({ seams = {} }: { seams?: SyncSeams }) {
  const username = useSync((s) => s.username);
  const status = useSync((s) => s.status);
  const unlocked = useSync((s) => s.unlocked);
  const pending = useSync((s) => s.pending);
  const quota = useSync((s) => s.quota);
  const lastSyncAt = useSync((s) => s.lastSyncAt);
  const message = useSync((s) => s.message);
  const pendingChoice = useSync((s) => s.pendingChoice);
  const refresh = useSync((s) => s.refresh);

  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [nextPw, setNextPw] = useState('');
  const [nextPw2, setNextPw2] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotCode, setForgotCode] = useState('');
  const [forgotPw, setForgotPw] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const backendMissing = !syncApiBaseUrl() && !seams.baseUrl;

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setLocalError(null);
    try {
      await fn();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRegister = async () => {
    if (password.length < 6) {
      setLocalError('密码至少 6 个字符');
      return;
    }
    if (password !== confirm) {
      setLocalError('两次输入的密码不一样');
      return;
    }
    await run(async () => {
      const out = await useSync.getState().register({ username: name, password, inviteCode, ...seams });
      setRecoverySaved(false);
      setRecoveryCode(out.recoveryCode);
      setPassword('');
      setConfirm('');
    });
  };

  const onLogin = async () => {
    await run(async () => {
      await useSync.getState().login({ username: name, password, ...seams });
      setPassword('');
    });
  };

  const onUnlock = async () => {
    await run(async () => {
      await useSync.getState().unlock(password, seams);
      setPassword('');
    });
  };

  const onChangePassword = async () => {
    if (nextPw.length < 6) {
      setLocalError('新密码至少 6 个字符');
      return;
    }
    if (nextPw !== nextPw2) {
      setLocalError('两次输入的新密码不一样');
      return;
    }
    await run(async () => {
      const out = await useSync.getState().changePassword(currentPw, nextPw, seams);
      setCurrentPw('');
      setNextPw('');
      setNextPw2('');
      setPasswordOpen(false);
      setRecoverySaved(false);
      setRecoveryCode(out.recoveryCode);
    });
  };

  /**
   * 刪除帳號：雲端先刪成功才清本機（見 useSync.deleteAccount 的註解）。
   * 成功後 useSync 會自己清本機、換回預設庫、發 bumpData，畫面自動回到未登入狀態。
   */
  const onDeleteAccount = async () => {
    await run(() => useSync.getState().deleteAccount(seams));
    setDeleteOpen(false);
    setDeleteConfirm('');
  };

  const onRecover = async () => {
    if (forgotPw.length < 6) {
      setLocalError('新密码至少 6 个字符');
      return;
    }
    await run(async () => {
      const out = await useSync.getState().recoverAccount({
        username: name, recoveryCode: forgotCode, newPassword: forgotPw, ...seams,
      });
      setForgotCode('');
      setForgotPw('');
      setForgotMode(false);
      setRecoverySaved(false);
      setRecoveryCode(out.recoveryCode);
    });
  };

  /**
   * 恢復碼對話框一定要掛在最外層：註冊成功後元件會立刻切到「已登入」分支，
   * 若把對話框寫在未登入分支裡，使用者**永遠看不到恢復碼**——那等於永久失去救回資料的唯一方法。
   */
  const recoveryDialog = recoveryCode ? (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-6">
      <div className="w-full rounded-2xl bg-white p-4">
        <div className="mb-2 text-[14px] font-semibold text-slate-800">请抄下恢复码</div>
        <div className="mb-2 text-[12px] text-slate-500">
          忘记密码时，它是唯一能救回云端数据的办法。服务器不保存它，我们也救不了没抄的人。关闭后不会再显示。
        </div>
        <div className="mb-3 select-all break-all rounded-xl bg-black/5 px-3 py-2 font-mono text-[12px] text-slate-700">
          {formatRecoveryCode(recoveryCode)}
        </div>
        <label className="mb-3 flex items-center gap-2 text-[12px] text-slate-600">
          <input type="checkbox" checked={recoverySaved} onChange={(e) => setRecoverySaved(e.target.checked)} />
          我已抄下恢复码
        </label>
        <button type="button" disabled={!recoverySaved} className="dsh-btn w-full py-2.5 text-[13px]"
          onClick={() => setRecoveryCode(null)}>
          完成
        </button>
      </div>
    </div>
  ) : null;

  /**
   * 两边都有资料时的取舍（登录后 status === 'needs-choice'）。
   * 必须在 pull 之前问：pull 一跑，本地那份就被盖掉了。
   */
  if (status === 'needs-choice') {
    return (
      <>
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">账号</h2>
          <div className="dsh-card space-y-3 p-3.5">
            <div className="text-[13px] font-medium text-slate-700">这台装置和云端都有资料</div>
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
              本机有 {pendingChoice?.localRows ?? '若干'} 笔还没推上去的改动，云端已用
              {' '}{formatBytes(pendingChoice?.cloudBytes ?? 0)}。
              两边内容不一样，需要你决定保留哪一边（这一步不能自动猜）。
            </div>
            <button
              type="button"
              disabled={busy}
              className="dsh-btn w-full py-2.5 text-[13px]"
              onClick={() => void run(() => useSync.getState().resolveConflictChoice('cloud', seams))}
            >
              以云端为准（这台装置的资料会被覆盖）
            </button>
            <button
              type="button"
              disabled={busy}
              className="dsh-btn-ghost w-full py-2.5 text-[13px]"
              onClick={() => void run(() => useSync.getState().resolveConflictChoice('local', seams))}
            >
              以本机为准（会覆盖云端）
            </button>
            <button
              type="button"
              className="w-full py-2 text-[12px] text-slate-400 underline"
              onClick={() => useSync.setState({ status: 'idle', pendingChoice: null, message: null })}
            >
              先不同步
            </button>
            <div className="text-[11px] leading-relaxed text-slate-400">
              「以本机为准」会先给本机拍一份快照，再拉一遍云端（拿到版本号），最后用快照盖回去并推上去 ——
              过程中不会丢掉任何一边还没备份的内容；真的担心就先「导出全部数据」。
            </div>
          </div>
        </section>
        {recoveryDialog}
      </>
    );
  }

  /*
   * 已登入面板只認 unlocked（本次打開頁面後成功解出 DEK），不能只看 username：
   * 密碼打錯時 username 與 token 都還在，光看 username 就會出現「密碼錯也登入成功」的假象。
   * status === 'error' 時只要 unlocked 也照樣顯示面板 —— 那才是真正的同步錯誤。
   */
  if (username && unlocked) {
    const used = quota?.used ?? 0;
    const limit = quota?.limit ?? 0;
    // quota 還沒拉回來時不要顯示「0 B / 1 B」那種假數字
    const usageText = limit > 0 ? `${formatBytes(used)} / ${formatBytes(limit)}` : '—';
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return (
      <>
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">账号</h2>
          <div className="dsh-card space-y-3 p-3.5">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-slate-700">{username}</div>
                <div className="text-[11px] text-slate-400">
                  {status === 'syncing' ? '同步中…' : pending > 0 ? `${pending} 笔待同步` : '已同步'} · {formatTime(lastSyncAt)}
                </div>
              </div>
              <span className={`text-[11px] ${status === 'error' ? 'text-red-500' : 'text-[#34c759]'}`}>
                {status === 'error' ? '同步失败' : '云端已加密'}
              </span>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                <span>云端空间</span>
                <span>{usageText}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full bg-[#0072E3]" style={{ width: `${percent}%` }} />
              </div>
            </div>

            {message && <div className="rounded-xl bg-black/5 px-3 py-2 text-[12px] text-slate-600">{message}</div>}
            <ConflictPanel />

            <DevicesPanel seams={seams} />

            <div className="flex gap-2">
              <button type="button" disabled={busy} className="dsh-btn flex-1 py-2.5 text-[13px]"
                onClick={() => void run(() => useSync.getState().runSync(seams, { askIfBothSides: true }))}>
                {busy ? '同步中…' : '立即同步'}
              </button>
              <button type="button" className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500"
                onClick={() => void run(() => useSync.getState().logout())}>
                退出登录
              </button>
            </div>

            <button type="button" className="w-full rounded-xl border border-black/10 py-2 text-[12px] text-slate-500"
              onClick={() => { setPasswordOpen((v) => !v); setLocalError(null); }}>
              {passwordOpen ? '收起' : '修改密码'}
            </button>
            {passwordOpen && (
              <div className="space-y-2">
                <input className={inputClass} type="password" placeholder="当前密码" value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)} />
                <input className={inputClass} type="password" placeholder="新密码（至少 6 位）" value={nextPw}
                  onChange={(e) => setNextPw(e.target.value)} />
                <input className={inputClass} type="password" placeholder="再输一次新密码" value={nextPw2}
                  onChange={(e) => setNextPw2(e.target.value)} />
                {localError && <div className="text-[12px] text-red-500">{localError}</div>}
                <button type="button" disabled={busy} className="dsh-btn w-full py-2.5 text-[13px]"
                  onClick={() => void onChangePassword()}>
                  {busy ? '处理中…' : '确认修改'}
                </button>
                <div className="text-[11px] text-slate-400">
                  修改后会给出一组新的恢复码，旧的立刻失效；其他设备下次重新解锁时要用新密码。
                </div>
              </div>
            )}
            <div className="text-[11px] text-slate-400">
              API Key 只存在本机，永远不会上传；退出登录后本机数据保留。
            </div>

            <div className="rounded-xl border border-red-100 bg-red-50/60 p-3">
              <div className="text-[12px] font-medium text-red-600">危险操作</div>
              <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
                删除账号会清掉云端这一份的<span className="text-slate-600">全部数据</span>（变更记录、密文、素材）
                以及所有设备的登录状态，<span className="text-red-600">不可复原</span>，本机数据也会一起清掉。
                想留着就先「导出全部数据」。
              </div>
              {deleteOpen ? (
                <div className="mt-2 space-y-2">
                  <input className={inputClass} placeholder={`输入账号名 ${username} 以确认`} value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy || deleteConfirm.trim().toLowerCase() !== username}
                      className="flex-1 rounded-xl bg-red-500 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
                      onClick={() => void onDeleteAccount()}
                    >
                      {busy ? '正在删除…' : '确认删除账号与云端数据'}
                    </button>
                    <button type="button" className="rounded-xl border border-black/10 px-4 py-2 text-[12px] text-slate-500"
                      onClick={() => { setDeleteOpen(false); setDeleteConfirm(''); }}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="mt-2 w-full rounded-full border py-2 text-[12px]"
                  style={{ borderColor: 'rgba(239,68,68,0.28)', color: '#ef4444' }}
                  onClick={() => { setDeleteOpen(true); setLocalError(null); }}
                >
                  删除账号与云端数据
                </button>
              )}
            </div>
          </div>
        </section>
        {recoveryDialog}
      </>
    );
  }

  if (status === 'locked') {
    return (
      <>
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">账号</h2>
          <div className="dsh-card space-y-2.5 p-3.5">
            <div className="text-[12px] text-slate-500">
              已登录 <span className="font-medium text-slate-700">{username}</span>
              ，但本次打开需要重新解锁（解密密钥只存在内存里）。
            </div>
            <input className={inputClass} type="password" placeholder="输入密码解锁" value={password}
              onChange={(e) => setPassword(e.target.value)} />
            {(localError || message) && <div className="text-[12px] text-red-500">{localError ?? message}</div>}
            <div className="flex gap-2">
              <button type="button" disabled={busy} className="dsh-btn flex-1 py-2.5 text-[13px]"
                onClick={() => void onUnlock()}>{busy ? '解锁中…' : '解锁'}</button>
              <button type="button" className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500"
                onClick={() => void run(() => useSync.getState().logout())}>改用其他账号</button>
            </div>
          </div>
        </section>
        {recoveryDialog}
      </>
    );
  }

  return (
    <>
      <section>
        <h2 className="mb-2 text-[13px] font-semibold text-slate-600">账号</h2>
        <div className="dsh-card space-y-2.5 p-3.5">
          <div className="text-[12px] text-slate-500">
            登录后可在多台设备之间同步（云端只有密文）。不登录也一样能玩，数据留在本机。
          </div>

          {(localError || message) && <div className="text-[12px] text-red-500">{localError ?? message}</div>}

          {backendMissing && !forgotMode && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
              这个版本没有配置同步后端（VITE_SYNC_API），账号功能不可用。
            </div>
          )}

          {forgotMode ? (
            <>
              <div className="rounded-xl bg-black/5 px-3 py-2 text-[12px] text-slate-600">
                输入账号名与恢复码，并用新密码重新包一份解密密钥。没有恢复码就无法救回云端数据（本机数据不受影响）。
              </div>
              <input className={inputClass} placeholder="账号名（小写字母、数字、- 和 _）" value={name}
                onChange={(e) => setName(e.target.value)} />
              <input className={inputClass} placeholder="恢复码（可含 - 与空格）" value={forgotCode}
                onChange={(e) => setForgotCode(e.target.value)} />
              <input className={inputClass} type="password" placeholder="新密码（至少 6 位）" value={forgotPw}
                onChange={(e) => setForgotPw(e.target.value)} />
              <div className="flex gap-2">
                <button type="button" disabled={busy || backendMissing} className="dsh-btn flex-1 py-2.5 text-[13px]"
                  onClick={() => void onRecover()}>
                  {busy ? '处理中…' : '用恢复码救回'}
                </button>
                <button type="button" className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500"
                  onClick={() => { setForgotMode(false); setLocalError(null); }}>
                  返回登录
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <button type="button" className={mode === 'register' ? 'dsh-chip dsh-chip-active flex-1 py-2' : 'dsh-chip flex-1 py-2'}
                  onClick={() => setMode('register')}>注册（需邀请码）</button>
                <button type="button" className={mode === 'login' ? 'dsh-chip dsh-chip-active flex-1 py-2' : 'dsh-chip flex-1 py-2'}
                  onClick={() => setMode('login')}>登录</button>
              </div>

              <input className={inputClass} placeholder="账号名（小写字母、数字、- 和 _）" value={name}
                onChange={(e) => setName(e.target.value)} />
              <input className={inputClass} type="password" placeholder="密码" value={password}
                onChange={(e) => setPassword(e.target.value)} />

              {mode === 'register' && (
                <>
                  <input className={inputClass} type="password" placeholder="再输一次密码" value={confirm}
                    onChange={(e) => setConfirm(e.target.value)} />
                  <input className={inputClass} placeholder="邀请码" value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)} />
                </>
              )}

              <button type="button" disabled={busy || backendMissing} className="dsh-btn w-full py-2.5 text-[13px]"
                onClick={() => void (mode === 'register' ? onRegister() : onLogin())}>
                {busy ? '处理中…' : mode === 'register' ? '注册并开始同步' : '登录并同步'}
              </button>
              <button type="button" className="w-full text-[12px] text-slate-400 underline"
                onClick={() => { setForgotMode(true); setLocalError(null); }}>
                忘记密码？用恢复码救回
              </button>
            </>
          )}
        </div>
      </section>
      {recoveryDialog}
    </>
  );
}
