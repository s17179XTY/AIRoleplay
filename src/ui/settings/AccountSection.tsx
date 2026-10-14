import { useEffect, useState } from 'react';
import { useSync, type SyncSeams } from '../../state/useSync';
import { formatRecoveryCode } from '../../core/sync/kdf';
import { syncApiBaseUrl } from '../../core/sync/session';

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
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 设置页的「账号」分节。
 * 未登录时只是一个可选的入口——不挡任何玩法（见 AGENTS.md 的「本地优先」硬约束）。
 * seams 是给测试注入假服务器用的，正式渲染不传。
 */
export default function AccountSection({ seams = {} }: { seams?: SyncSeams }) {
  const username = useSync((s) => s.username);
  const status = useSync((s) => s.status);
  const pending = useSync((s) => s.pending);
  const conflicts = useSync((s) => s.conflicts);
  const quota = useSync((s) => s.quota);
  const lastSyncAt = useSync((s) => s.lastSyncAt);
  const message = useSync((s) => s.message);
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

  if (username && status !== 'signed-out' && status !== 'locked') {
    const used = quota?.used ?? 0;
    const limit = quota?.limit ?? 1;
    const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
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
                <span>{formatBytes(used)} / {formatBytes(limit)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full bg-[#0072E3]" style={{ width: `${percent}%` }} />
              </div>
            </div>

            {message && <div className="rounded-xl bg-black/5 px-3 py-2 text-[12px] text-slate-600">{message}</div>}
            {conflicts > 0 && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                {conflicts} 笔冲突已保留本地副本（另一台设备的改动被覆盖前会先留在这里）
              </div>
            )}

            <div className="flex gap-2">
              <button type="button" disabled={busy} className="dsh-btn flex-1 py-2.5 text-[13px]"
                onClick={() => void run(() => useSync.getState().runSync(seams))}>
                {busy ? '同步中…' : '立即同步'}
              </button>
              <button type="button" className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500"
                onClick={() => void run(() => useSync.getState().logout())}>
                退出登录
              </button>
            </div>
            <div className="text-[11px] text-slate-400">
              API Key 只存在本机，永远不会上传；退出登录后本机数据保留。
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

          {backendMissing && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
              这个版本没有配置同步后端（VITE_SYNC_API），账号功能不可用。
            </div>
          )}

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

          {(localError || message) && <div className="text-[12px] text-red-500">{localError ?? message}</div>}

          <button type="button" disabled={busy || backendMissing} className="dsh-btn w-full py-2.5 text-[13px]"
            onClick={() => void (mode === 'register' ? onRegister() : onLogin())}>
            {busy ? '处理中…' : mode === 'register' ? '注册并开始同步' : '登录并同步'}
          </button>
        </div>
      </section>
      {recoveryDialog}
    </>
  );
}
