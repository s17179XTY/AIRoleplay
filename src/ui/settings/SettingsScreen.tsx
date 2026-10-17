import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../../core/storage/db';
import type { ModelCapability, ModelParams, ModelPresetRecord, ProviderRecord, RegexScriptRecord } from '../../core/storage/types';
import { DEFAULT_CAPABILITY, DEFAULT_CONTEXT_LIMIT, DEFAULT_PARAMS, DEFAULT_SUMMARY_TRIGGER, SETTING_CONTEXT_LIMIT, SETTING_CONTEXT_MODE, SETTING_SUMMARY_TRIGGER, SUMMARY_MAX_PAIRS_PER_RUN, SUMMARY_TARGET_PERCENT, SUMMARY_TRIGGER_MAX, SUMMARY_TRIGGER_MIN, type ContextMode } from '../../core/storage/types';
import {
  deletePreset, deleteProvider, getActive, listPresets, listProviders,
  savePreset, saveProvider, setActive, testConnection,
} from '../../core/storage/providerRepo';
import { defaultCapabilityFor } from '../../core/providers/registry';
import { exportAll, importAll } from '../../core/storage/backup';
import { clearLocalData, resetDefaultCards, resetSettings } from '../../core/storage/reset';
import { downloadBytes, readFileBytes } from '../cards/fileUtils';
import { newRegexScript } from '../cards/draft';
import { resetSettingCache, useSetting, useSettingFlag } from '../../state/useSetting';
import { useData } from '../../state/useData';
import { useSession } from '../../state/useSession';
import { useNav } from '../../state/useNav';
import AccountSection from './AccountSection';
import ModSection from './ModSection';

const inputClass = 'w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0072E3]';

/** 上下文条数的合法范围。填错只在「保存」时挡，不要在使用者打字当下把值抢走。 */
const CONTEXT_LIMIT_MIN = 1;
const CONTEXT_LIMIT_MAX = 100;
const DEFAULT_CONTEXT_LIMIT_TEXT = String(DEFAULT_CONTEXT_LIMIT);

/** 本机 / 内网地址：这些服务商（Ollama、LM Studio、局域网中转）本来就不需要 API Key */
const LOCAL_BASE_URL_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?(\/|$)/i;

interface ProviderForm {
  id?: string;
  label: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  headers: string;
}

const emptyProviderForm: ProviderForm = {
  label: '', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', headers: '{}',
};

export default function SettingsScreen() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [presets, setPresets] = useState<ModelPresetRecord[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetProvider, setPresetProvider] = useState('');
  const [presetModel, setPresetModel] = useState('');
  const [params, setParams] = useState<ModelParams>({ ...DEFAULT_PARAMS });
  const [capabilities, setCapabilities] = useState<ModelCapability>({ ...DEFAULT_CAPABILITY });
  /**
   * 上下文条数刻意用**字串**存：用 number 的話，使用者把欄位清空會變成 `Number('') = 0`，
   * 受控 input 立刻被塞回一個 0，變成「打都打不了字」。改成存字串、按保存時才驗證。
   */
  const [globalConfig, setGlobalConfig] = useState({
    contextLimit: DEFAULT_CONTEXT_LIMIT_TEXT, prePrompt: '', postPrompt: '', prompt: '',
  });
  const [contextMode, setContextMode] = useState<ContextMode>('recent');
  const [contextLimitError, setContextLimitError] = useState<string | null>(null);
  /**
   * 使用者在這一頁動過的欄位，refresh() 不可以再拿資料庫的值蓋回去。
   * 為什麼需要：refresh() 是异步的（要读 4~5 张表），使用者可能在它 resolve 之前
   * 就点了「全部带」——那一下会被随后落地的 refresh() 悄悄改回旧值。
   */
  const formTouchedRef = useRef(false);
  const [summaryOn, setSummaryOn] = useSettingFlag('summaryEnabled', true);
  const [summaryBatch, setSummaryBatch] = useState('1');
  const [summaryTrigger, setSummaryTrigger] = useState(String(DEFAULT_SUMMARY_TRIGGER));
  const showToast = useNav((s) => s.showToast);
  const reloadCard = useSession((s) => s.reloadCard);
  const reloadSession = useSession((s) => s.reload);
  const refreshModelLabel = useSession((s) => s.refreshModelLabel);
  const [fontScale, setFontScale] = useSetting('fontScale', '16');
  const [globalRules, setGlobalRules] = useState<RegexScriptRecord[]>([]);
  const backupRef = useRef<HTMLInputElement>(null);
  const [chatsCount, setChatsCount] = useState(0);
  const dataVersion = useData((s) => s.version);

  const refresh = useCallback(async () => {
    const [ps, ms, active] = await Promise.all([listProviders(), listPresets(), getActive()]);
    setProviders(ps);
    setPresets(ms);
    setActiveProviderId(active?.provider.id ?? null);
    setActivePresetId(active?.preset.id ?? null);
    const cfg = await db.configs.where('scope').equals('global').first();
    const [modeRow, limitRow, batchRow, triggerRow] = await Promise.all([
      db.settings.get(SETTING_CONTEXT_MODE).catch(() => undefined),
      db.settings.get(SETTING_CONTEXT_LIMIT).catch(() => undefined),
      db.settings.get('summaryBatchPairs').catch(() => undefined),
      db.settings.get(SETTING_SUMMARY_TRIGGER).catch(() => undefined),
    ]);
    if (!formTouchedRef.current) {
      setContextMode(modeRow?.value === 'all' ? 'all' : 'recent');
      setSummaryBatch(String(batchRow?.value ?? '1'));
      setSummaryTrigger(String(triggerRow?.value ?? DEFAULT_SUMMARY_TRIGGER));
      setGlobalConfig({
        // 沒有設定列時顯示預設值，而不是 0——那個 0 就是使用者抱怨「刪掉又自己彈回來」的元凶
        contextLimit: String(limitRow?.value ?? DEFAULT_CONTEXT_LIMIT_TEXT),
        prePrompt: cfg?.prePrompt ?? '',
        postPrompt: cfg?.postPrompt ?? '',
        prompt: cfg?.prompt ?? '',
      });
    }
    const rules = await db.regexScripts.where('scope').equals('global').toArray();
    setGlobalRules(rules.sort((a, b) => a.order - b.order));
    setChatsCount(await db.chats.count());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 登入 / 登出 / 同步之後，這一頁也要跟著換一份資料
  useEffect(() => {
    if (dataVersion > 0) void refresh();
  }, [dataVersion, refresh]);

  const onSaveProvider = async () => {
    if (!form) return;
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = form.headers.trim() ? (JSON.parse(form.headers) as Record<string, string>) : {};
    } catch {
      showToast('额外请求头必须是合法 JSON');
      return;
    }
    // API Key 必填；但本机/内网服务商（Ollama、LM Studio、局域网中转）本来就不需要密钥，放行
    if (!form.apiKey.trim() && !LOCAL_BASE_URL_RE.test(form.baseUrl.trim())) {
      showToast('API Key 不能为空（本机/内网地址可留空）');
      return;
    }
    await saveProvider({
      id: form.id, label: form.label || '未命名服务商', protocol: form.protocol,
      baseUrl: form.baseUrl, apiKey: form.apiKey, extraHeaders,
    });
    setForm(null);
    setTestMsg(null);
    await refresh();
    showToast('服务商已保存');
  };

  const onTest = async (provider: ProviderRecord) => {
    setTestMsg('测试中…');
    try {
      await testConnection(provider);
      setTestMsg('连接成功');
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setTestMsg('连接失败：' + raw + '（若为 Failed to fetch，多为该站不允许浏览器直连 CORS）');
    }
  };

  const onSaveGlobal = async () => {
    // 只在保存時驗證：欄位是空的（或不是整數、超出範圍）就不給存，並指出問題
    const raw = globalConfig.contextLimit.trim();
    const limit = Number(raw);
    if (contextMode === 'recent' && (!raw || !Number.isInteger(limit) || limit < CONTEXT_LIMIT_MIN || limit > CONTEXT_LIMIT_MAX)) {
      setContextLimitError(`上下文条数要填 ${CONTEXT_LIMIT_MIN}–${CONTEXT_LIMIT_MAX} 之间的整数`);
      showToast('上下文条数不合法，没有保存');
      return;
    }
    setContextLimitError(null);
    const batchNum = Number(summaryBatch.trim());
    const batch = Number.isInteger(batchNum) && batchNum >= 1 && batchNum <= 5 ? batchNum : 1;
    const triggerNum = Number(summaryTrigger.trim());
    const trigger = Number.isInteger(triggerNum) && triggerNum >= SUMMARY_TRIGGER_MIN && triggerNum <= SUMMARY_TRIGGER_MAX
      ? triggerNum
      : DEFAULT_SUMMARY_TRIGGER;
    await db.settings.put({ key: SETTING_CONTEXT_MODE, value: contextMode });
    await db.settings.put({ key: SETTING_CONTEXT_LIMIT, value: String(Number.isFinite(limit) && limit >= 1 ? limit : DEFAULT_CONTEXT_LIMIT) });
    await db.settings.put({ key: 'summaryBatchPairs', value: String(batch) });
    await db.settings.put({ key: SETTING_SUMMARY_TRIGGER, value: String(trigger) });
    setSummaryBatch(String(batch));
    setSummaryTrigger(String(trigger));
    const existing = await db.configs.where('scope').equals('global').first();
    await db.configs.put({
      id: existing?.id ?? 'global-config',
      scope: 'global',
      refId: null,
      memoryLimit: existing?.memoryLimit ?? 6,
      prePrompt: globalConfig.prePrompt,
      postPrompt: globalConfig.postPrompt,
      prompt: globalConfig.prompt,
    });
    showToast('全局配置已保存');
    // 存完了：之後的 refresh() 可以再拿資料庫的值（例如同步拉進別台裝置的設定）
    formTouchedRef.current = false;
  };

  const addGlobalRule = async () => {
    const rule = newRegexScript(globalRules.length);
    await db.regexScripts.put({
      id: rule.id, scope: 'global', chatId: null, name: rule.name, pattern: rule.pattern,
      flags: rule.flags, replacement: rule.replacement, enabled: rule.enabled,
      order: rule.order, target: 'display',
    });
    await refresh();
  };

  const patchGlobalRule = async (id: string, patch: Partial<RegexScriptRecord>) => {
    const row = await db.regexScripts.get(id);
    if (!row) return;
    await db.regexScripts.put({ ...row, ...patch });
    setGlobalRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeGlobalRule = async (id: string) => {
    await db.regexScripts.delete(id);
    await refresh();
  };

  const onExportBackup = async () => {
    const bytes = await exportAll();
    downloadBytes(bytes, 'dsh-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('备份已导出');
  };

  const onImportBackup = async (file: File) => {
    try {
      const bytes = await readFileBytes(file);
      await importAll(bytes);
      await refresh();
      await reloadCard();
      showToast('备份已导入');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const onSavePreset = async () => {
    if (!presetProvider || !presetModel.trim()) {
      showToast('请选择服务商并填写模型名');
      return;
    }
    const presetId = await savePreset({
      id: editingPresetId ?? undefined,
      providerId: presetProvider,
      model: presetModel.trim(),
      params,
      capabilities,
    });
    setPresetOpen(false);
    setPresetModel('');
    const wasEditing = Boolean(editingPresetId);
    setEditingPresetId(null);
    // 還沒有任何「使用中」的模型（等於正在用 mock）→ 保存後直接切過去，不必再手動點一次
    const autoSwitched = !wasEditing && (await getActive()) === null;
    if (autoSwitched) await setActive(presetProvider, presetId);
    await refresh();
    await refreshModelLabel();
    if (wasEditing) showToast('模型配置已更新');
    else showToast(autoSwitched ? '模型配置已保存，并已从 mock 切换到它' : '模型配置已保存');
  };

  /** 编辑已有模型配置：把型号、参数与能力勾选载回表单 */
  const openPresetEditor = (preset: ModelPresetRecord) => {
    setEditingPresetId(preset.id);
    setPresetProvider(preset.providerId);
    setPresetModel(preset.model);
    setParams({ ...DEFAULT_PARAMS, ...preset.params });
    setCapabilities({ ...defaultCapabilityFor('openai'), ...preset.capabilities });
    setPresetOpen(true);
  };

  /** 恢復預設設定：保留服務商與模型配置，其餘設定回到出廠值 */
  const onResetSettings = async () => {
    const okToReset = window.confirm(
      '恢复默认设置？\n\n会清掉：记忆条数、全局提示词 / 前置词 / 后置词、字号、记忆托管开关。\n会保留：服务商与模型配置（含 API Key）、卡片、对话、记忆库、正则脚本。',
    );
    if (!okToReset) return;
    await resetSettings();
    resetSettingCache();
    await refresh();
    await reloadSession();
    showToast('已恢复默认设置（服务商与模型配置保留）');
  };

  /** 恢復預設卡片：無條件用內置卡片包覆蓋內置示範卡 */
  const onResetCards = async () => {
    const okToReset = window.confirm(
      '恢复默认卡片？\n\n「性癖大图鉴 · 寻找新XP」这一张内置卡会被还原成出厂状态（提示词、互动页、空世界书）。\n你自己导入或新建的卡片不受影响。',
    );
    if (!okToReset) return;
    await resetDefaultCards();
    await reloadCard();
    await reloadSession();
    showToast('内置卡片已恢复默认');
  };

  const onClearLocal = async () => {
    const okToClear = window.confirm(
      '清空本机所有数据？\n\n卡片、对话、消息、记忆库、设置都会删除（内置卡会在下次进入时自动重建）。\n云端那份不受影响，下次登录会重新同步回来。',
    );
    if (!okToClear) return;
    await clearLocalData();
    resetSettingCache();
    useData.getState().bump('cleared');
    showToast('本机数据已清空');
  };

  const supportedFields: { key: keyof ModelParams; label: string; supported: boolean; step: number; min: number; max: number }[] = [
    { key: 'contextLength', label: '上下文大小（模型能吃多少 token）', supported: true, step: 4096, min: 4096, max: 2000000 },
    { key: 'temperature', label: '温度', supported: capabilities.temperature, step: 0.05, min: 0, max: 2 },
    { key: 'topP', label: 'top_p', supported: capabilities.topP, step: 0.05, min: 0, max: 1 },
    { key: 'presencePenalty', label: '存在惩罚', supported: capabilities.presencePenalty, step: 0.1, min: -2, max: 2 },
    { key: 'frequencyPenalty', label: '频率惩罚', supported: capabilities.frequencyPenalty, step: 0.1, min: -2, max: 2 },
    { key: 'maxTokens', label: '最大回复长度', supported: capabilities.maxTokens, step: 256, min: 256, max: 128000 },
    { key: 'thinkingBudget', label: '思考预算', supported: capabilities.thinkingBudget, step: 512, min: 0, max: 32000 },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="dsh-header sticky top-0 z-10 px-4 pb-2.5 pt-3.5">
        <div className="text-[15px] font-semibold text-slate-800">设置</div>
        <div className="text-[11px] text-slate-400">模型由你自己接入；数据默认留在本机，登录后可加密同步</div>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <AccountSection />

        <ModSection />

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-slate-600">模型接入</h2>
            <button type="button" className="text-[12px] text-[#0072E3]"
              onClick={() => { setForm({ ...emptyProviderForm }); setTestMsg(null); }}>
              + 添加服务商
            </button>
          </div>

          {providers.map((p) => (
            <div key={p.id} className="dsh-card mb-2 p-3.5">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-slate-700">
                    {p.label}
                    {activeProviderId === p.id && <span className="ml-2 text-[11px] text-[#0072E3]">使用中</span>}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">{p.protocol} · {p.baseUrl}</div>
                </div>
                <div className="flex shrink-0 gap-2 text-[12px]">
                  <button type="button" className="text-slate-500" onClick={() => void onTest(p)}>测试</button>
                  <button type="button" className="text-slate-500"
                    onClick={() => { setForm({ id: p.id, label: p.label, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, headers: JSON.stringify(p.extraHeaders ?? {}, null, 2) }); setTestMsg(null); }}>
                    编辑
                  </button>
                  <button type="button" className="text-red-500" onClick={() => void deleteProvider(p.id).then(refresh)}>删除</button>
                </div>
              </div>
            </div>
          ))}

          {testMsg && <div className="mb-2 rounded-xl bg-black/5 px-3 py-2 text-[12px] text-slate-600">{testMsg}</div>}

          {form && (
            <div className="dsh-card mb-2 space-y-2.5 p-3.5">
              <input className={inputClass} placeholder="服务商名称" value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })} />
              <select className={inputClass} value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value === 'anthropic' ? 'anthropic' : 'openai' })}>
                <option value="openai">OpenAI 兼容（DeepSeek / OpenRouter / 中转站 / Ollama）</option>
                <option value="anthropic">Anthropic 原生（Claude）</option>
              </select>
              <input className={inputClass} placeholder="Base URL，例如 https://api.deepseek.com" value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              <input className={inputClass} placeholder="API Key" value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
              <textarea className={inputClass + ' font-mono text-[11px]'} rows={3} placeholder='额外请求头 JSON，例如 {"X-Token":"..."}'
                value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} />
              <div className="flex gap-2">
                <button type="button" onClick={() => void onSaveProvider()}
                  className="dsh-btn flex-1 py-2.5 text-[13px]">保存服务商</button>
                <button type="button" onClick={() => setForm(null)}
                  className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500">取消</button>
              </div>
            </div>
          )}

          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[12px] font-medium text-slate-500">模型配置</h3>
            <button type="button" className="text-[12px] text-[#0072E3]"
              onClick={() => {
                const pid = providers[0]?.id ?? '';
                setPresetProvider(pid);
                setCapabilities({ ...defaultCapabilityFor(providers[0]?.protocol ?? 'openai') });
                setParams({ ...DEFAULT_PARAMS });
                setPresetOpen(true);
              }}>
              + 新增模型配置
            </button>
          </div>

          {presets.map((m) => {
            const provider = providers.find((p) => p.id === m.providerId);
            return (
              <div key={m.id} className="dsh-card mb-2 flex items-center justify-between px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-slate-700">
                    {m.model}
                    {activePresetId === m.id && <span className="ml-2 text-[11px] text-[#0072E3]">使用中</span>}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">{provider?.label ?? '（服务商已删除）'}</div>
                </div>
                <div className="flex shrink-0 gap-2 text-[12px]">
                  <button type="button" className="text-[#0072E3]"
                    onClick={() => void setActive(m.providerId, m.id).then(refresh)}>设为当前</button>
                  <button type="button" className="text-slate-500"
                    onClick={() => openPresetEditor(m)}>编辑</button>
                  <button type="button" className="text-red-500"
                    onClick={() => void deletePreset(m.id).then(refresh)}>删除</button>
                </div>
              </div>
            );
          })}

          {activeProviderId && (
            <button type="button" className="dsh-btn-ghost w-full py-2.5 text-[12px]"
              onClick={() => void setActive(null, null).then(refresh)}>
              改回使用 mock 模拟模型
            </button>
          )}

          {presetOpen && (
            <div className="dsh-card mt-2 space-y-2.5 p-3.5">
              <select className={inputClass} value={presetProvider}
                onChange={(e) => {
                  setPresetProvider(e.target.value);
                  const p = providers.find((x) => x.id === e.target.value);
                  setCapabilities({ ...defaultCapabilityFor(p?.protocol ?? 'openai') });
                }}>
                <option value="">选择服务商</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input className={inputClass} placeholder="模型名，例如 deepseek-chat" value={presetModel}
                onChange={(e) => setPresetModel(e.target.value)} />

              {supportedFields.map((f) => (
                <div key={f.key} className={f.supported ? '' : 'opacity-40'}>
                  <div className="flex items-center justify-between text-[12px] text-slate-500">
                    <span>{f.label}{!f.supported && '（该协议不支持）'}</span>
                    <span>{String(params[f.key])}</span>
                  </div>
                  <input type="range" className="w-full" disabled={!f.supported} min={f.min} max={f.max} step={f.step}
                    value={params[f.key]}
                    onChange={(e) => setParams({ ...params, [f.key]: Number(e.target.value) })} />
                </div>
              ))}

              <div className="flex flex-wrap gap-3 text-[12px] text-slate-500">
                {(['temperature', 'topP', 'presencePenalty', 'frequencyPenalty', 'maxTokens', 'thinkingBudget'] as const).map((key) => (
                  <label key={key} className="flex items-center gap-1">
                    <input type="checkbox" checked={capabilities[key] as boolean}
                      onChange={(e) => setCapabilities({ ...capabilities, [key]: e.target.checked })} />
                    {key} 支持
                  </label>
                ))}
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={() => void onSavePreset()}
                  className="dsh-btn flex-1 py-2.5 text-[13px]">保存模型配置</button>
                <button type="button" onClick={() => setPresetOpen(false)}
                  className="rounded-xl border border-black/10 px-4 py-2 text-[13px] text-slate-500">取消</button>
              </div>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">上下文与记忆（对所有卡片生效）</h2>
          <div className="space-y-2 rounded-2xl border border-black/10 bg-white p-3">
            <div>
              <div className="mb-1.5 text-[12px] text-slate-500">上下文模式</div>
              <div className="flex gap-2">
                {([['recent', '只带最近 N 条'], ['all', '全部带']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { formTouchedRef.current = true; setContextMode(value); }}
                    className={(contextMode === value ? 'dsh-chip dsh-chip-active' : 'dsh-chip') + ' flex-1 justify-center py-2'}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                「只带最近 N 条」省钱，但更早的内容要靠下面的摘要记住；
                「全部带」记得最全（窗口内全部都带，受上下文预算裁剪与自动摘要保护），
                但每一轮都要送更多内容，越聊越贵。
              </div>
            </div>
            {contextMode === 'recent' && (
              <label className="block">
                <div className="mb-1 text-[12px] text-slate-500">最近 N 条消息</div>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="上下文条数"
                  className={inputClass}
                  value={globalConfig.contextLimit}
                  placeholder={DEFAULT_CONTEXT_LIMIT_TEXT}
                  onChange={(e) => {
                    // 直接存使用者打的字，不要在這裡 Number()——那會把空字串變成 0 而打不了字
                    formTouchedRef.current = true;
                    setGlobalConfig({ ...globalConfig, contextLimit: e.target.value });
                    setContextLimitError(null);
                  }}
                />
                <div className={'mt-1 text-[11px] ' + (contextLimitError ? 'text-red-500' : 'text-slate-400')}>
                  {contextLimitError ?? `默认 ${DEFAULT_CONTEXT_LIMIT_TEXT} 条（用户与 AI 各算一条，不含本轮输入）`}
                </div>
              </label>
            )}
            <div className="rounded-xl bg-black/[0.03] px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-slate-600">记忆库（自动摘要）</span>
                <button
                  type="button"
                  aria-label="记忆托管开关"
                  aria-pressed={summaryOn}
                  onClick={() => setSummaryOn(!summaryOn)}
                  className={'relative h-6 w-11 shrink-0 rounded-full transition ' + (summaryOn ? 'bg-[#0072E3]' : 'bg-black/15')}
                >
                  <span className={'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ' + (summaryOn ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
              <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                开启后：掉出上下文的对话**按对**（一条你的输入 + 一条 AI 回复）交给模型压成摘要，
                存进记忆库，并在下一轮提示词里以「更早的对话摘要」回注 —— 让 AI 记得窗口外面发生过什么。
                摘要分「用户 / 叙事」两段，AI 不会把你的选择当成自己写的。
                关掉后：窗口外的内容不再记录（长对话会失忆）。
              </div>
              {summaryOn && (
                <>
                  <label className="mt-2 block">
                    <div className="mb-1 text-[11px] text-slate-500">
                      上下文占用达到多少 % 就自动压缩旧对话（默认 {DEFAULT_SUMMARY_TRIGGER}，最高 {SUMMARY_TRIGGER_MAX}）
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="压缩触发阈值"
                      className={inputClass}
                      value={summaryTrigger}
                      placeholder={String(DEFAULT_SUMMARY_TRIGGER)}
                      onChange={(e) => { formTouchedRef.current = true; setSummaryTrigger(e.target.value); }}
                    />
                    <div className="mt-1 text-[11px] leading-relaxed text-slate-400">
                      达到阈值就从最老的对话开始压，压到大约 {SUMMARY_TARGET_PERCENT}% 就停手；
                      一次最多 {SUMMARY_MAX_PAIRS_PER_RUN} 对，不够下一轮继续。
                      「只带最近 N 条」模式另有规则：掉出窗口的对话一定会被压（否则直接丢失）。
                      已经压成摘要的原文不会再送进提示词（避免原文与摘要双份、越压越大）；
                      摘要如果并不比原文短，会直接保留原文，绝不「越压越长」。
                    </div>
                  </label>
                  <label className="mt-2 block">
                    <div className="mb-1 text-[11px] text-slate-500">攒够几对再压缩（N 对**合成 1 条**摘要；1 = 一掉出就压，调大更省钱）</div>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="攒够几对再压缩"
                      className={inputClass}
                      value={summaryBatch}
                      placeholder="1"
                      onChange={(e) => { formTouchedRef.current = true; setSummaryBatch(e.target.value); }}
                    />
                  </label>
                </>
              )}
            </div>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">全局前置词（排在全局提示词之前）</div>
              <textarea aria-label="全局前置词" className={inputClass} rows={3} value={globalConfig.prePrompt}
                onChange={(e) => setGlobalConfig({ ...globalConfig, prePrompt: e.target.value })} />
            </label>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">全局提示词</div>
              <textarea aria-label="全局提示词" className={inputClass} rows={4} value={globalConfig.prompt}
                onChange={(e) => setGlobalConfig({ ...globalConfig, prompt: e.target.value })} />
            </label>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">后置词</div>
              <textarea aria-label="全局后置词" className={inputClass} rows={3} value={globalConfig.postPrompt}
                onChange={(e) => setGlobalConfig({ ...globalConfig, postPrompt: e.target.value })} />
            </label>
            <button type="button" onClick={() => void onSaveGlobal()}
              className="dsh-btn w-full py-2.5 text-[13px]">保存全局配置</button>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">阅读设置</h2>
          <div className="dsh-card p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] text-slate-500">正文字号</span>
              <span className="text-[11px] text-slate-400">{fontScale}px</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              {[['14', '小'], ['16', '中'], ['18', '大'], ['20', '特大']].map(([v, label]) => {
                const active = fontScale === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setFontScale(v)}
                    style={{ fontSize: active ? '15px' : '11px' }}
                    className={
                      'transition-all duration-150 ' +
                      (active ? 'dsh-btn px-5 py-2.5 font-semibold' : 'dsh-chip px-3 py-1.5 opacity-70')
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 rounded-xl bg-black/[0.03] px-3 py-2 text-slate-600" style={{ fontSize: (Number(fontScale) || 16) + 'px' }}>
              预览：她抬头看了你一眼，走廊尽头的风吹得窗户轻轻响了一声。
            </div>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-slate-600">全局正则脚本</h2>
            <button type="button" className="text-[12px] text-[#0072E3]" onClick={() => void addGlobalRule()}>
              + 新增规则
            </button>
          </div>
          {globalRules.map((r) => (
            <div key={r.id} className="dsh-card mb-2 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <input
                  className="text-[12px] font-medium text-slate-600 outline-none"
                  value={r.name}
                  onChange={(e) => void patchGlobalRule(r.id, { name: e.target.value })}
                />
                <button type="button" className="text-[12px] text-red-500" onClick={() => void removeGlobalRule(r.id)}>
                  删除
                </button>
              </div>
              <input
                className={inputClass}
                placeholder="匹配规则（正则内容本身，不写 /.../g）"
                value={r.pattern}
                onChange={(e) => void patchGlobalRule(r.id, { pattern: e.target.value })}
              />
              <input
                className={inputClass + ' mt-2'}
                placeholder="替换文本（支持 $1 $2 与 HTML，留空为删除）"
                value={r.replacement}
                onChange={(e) => void patchGlobalRule(r.id, { replacement: e.target.value })}
              />
              <div className="mt-2 flex items-center gap-3 text-[12px] text-slate-500">
                <label className="flex items-center gap-1">
                  修饰符
                  <input
                    className="w-16 rounded-lg border border-black/10 px-1 py-0.5"
                    value={r.flags}
                    onChange={(e) => void patchGlobalRule(r.id, { flags: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={r.enabled} onChange={(e) => void patchGlobalRule(r.id, { enabled: e.target.checked })} />
                  启用
                </label>
              </div>
            </div>
          ))}
          {globalRules.length === 0 && (
            <div className="rounded-2xl border border-dashed border-black/15 py-4 text-center text-[12px] text-slate-400">
              还没有全局正则规则
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">数据管理</h2>
          <div className="space-y-2 rounded-2xl border border-black/10 bg-white p-3">
            <div className="text-[12px] text-slate-500">
              数据全部存在本机浏览器里。换设备或清理浏览器前，请先导出备份。
            </div>
            <button type="button" onClick={() => void onExportBackup()}
              className="dsh-btn w-full py-2.5 text-[13px]">
              导出全部数据
            </button>
            <button type="button" onClick={() => backupRef.current?.click()}
              className="dsh-btn-ghost w-full py-2.5 text-[13px]">
              导入备份
            </button>
            <input
              ref={backupRef}
              type="file"
              accept=".json,.dshbackup"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void onImportBackup(file);
              }}
            />
            <div className="text-[11px] text-slate-400">
              当前共 {chatsCount} 个会话 · 卡片与设置一并导出
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">恢复与重置</h2>
          <div className="space-y-2 rounded-2xl border border-black/10 bg-white p-3">
            <div className="text-[12px] text-slate-500">
              下面三个按钮都会先弹确认框，按了才真的执行。
            </div>
            <button type="button" onClick={() => void onResetSettings()}
              className="dsh-btn-ghost w-full py-2.5 text-[13px]">
              恢复默认设置
            </button>
            <div className="text-[11px] text-slate-400">
              清掉记忆条数、全局提示词 / 前置词 / 后置词、字号、记忆托管开关；
              <span className="text-slate-500">服务商与模型配置（含 API Key）会保留</span>，
              卡片、对话、记忆库、正则脚本也不动。
            </div>
            <button type="button" onClick={() => void onResetCards()}
              className="dsh-btn-ghost w-full py-2.5 text-[13px]">
              恢复默认卡片
            </button>
            <div className="text-[11px] text-slate-400">
              把内置那张「性癖大图鉴 · 寻找新XP」还原成出厂状态（自带互动页 + 空世界书）。
              你自己导入或新建的卡片不受影响。
            </div>
            <button type="button" onClick={() => void onClearLocal()}
              className="w-full rounded-full border py-2.5 text-[13px]"
              style={{ borderColor: 'rgba(239,68,68,0.28)', color: '#ef4444' }}>
              清空本机所有数据
            </button>
            <div className="text-[11px] text-slate-400">
              只清本机。云端那份要删，请到上面「账号」里用「删除账号与云端数据」。
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}