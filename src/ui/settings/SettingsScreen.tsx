import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../../core/storage/db';
import type { ModelCapability, ModelParams, ModelPresetRecord, ProviderRecord, RegexScriptRecord } from '../../core/storage/types';
import { DEFAULT_CAPABILITY, DEFAULT_PARAMS } from '../../core/storage/types';
import {
  deletePreset, deleteProvider, getActive, listPresets, listProviders,
  savePreset, saveProvider, setActive, testConnection,
} from '../../core/storage/providerRepo';
import { defaultCapabilityFor } from '../../core/providers/registry';
import { exportAll, importAll } from '../../core/storage/backup';
import { downloadBytes, readFileBytes } from '../cards/fileUtils';
import { newRegexScript } from '../cards/draft';
import { useSetting } from '../../state/useSetting';
import { useSession } from '../../state/useSession';
import { useNav } from '../../state/useNav';

const inputClass = 'w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0072E3]';

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
  const [presetProvider, setPresetProvider] = useState('');
  const [presetModel, setPresetModel] = useState('');
  const [params, setParams] = useState<ModelParams>({ ...DEFAULT_PARAMS });
  const [capabilities, setCapabilities] = useState<ModelCapability>({ ...DEFAULT_CAPABILITY });
  const [globalConfig, setGlobalConfig] = useState({ memoryLimit: 4, prePrompt: '', postPrompt: '', prompt: '' });
  const showToast = useNav((s) => s.showToast);
  const reloadCard = useSession((s) => s.reloadCard);
  const [fontScale, setFontScale] = useSetting('fontScale', '16');
  const [globalRules, setGlobalRules] = useState<RegexScriptRecord[]>([]);
  const backupRef = useRef<HTMLInputElement>(null);
  const [chatsCount, setChatsCount] = useState(0);

  const refresh = useCallback(async () => {
    const [ps, ms, active] = await Promise.all([listProviders(), listPresets(), getActive()]);
    setProviders(ps);
    setPresets(ms);
    setActiveProviderId(active?.provider.id ?? null);
    setActivePresetId(active?.preset.id ?? null);
    const cfg = await db.configs.where('scope').equals('global').first();
    if (cfg) setGlobalConfig({ memoryLimit: cfg.memoryLimit, prePrompt: cfg.prePrompt, postPrompt: cfg.postPrompt, prompt: cfg.prompt });
    const rules = await db.regexScripts.where('scope').equals('global').toArray();
    setGlobalRules(rules.sort((a, b) => a.order - b.order));
    setChatsCount(await db.chats.count());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaveProvider = async () => {
    if (!form) return;
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = form.headers.trim() ? (JSON.parse(form.headers) as Record<string, string>) : {};
    } catch {
      showToast('额外请求头必须是合法 JSON');
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
      const models = await testConnection(provider);
      setTestMsg(models.length > 0 ? '连接成功，可用模型 ' + models.length + ' 个：' + models.slice(0, 3).join(', ') : '连接成功，但没有返回模型列表');
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setTestMsg('连接失败：' + raw + '（若为 Failed to fetch，多为该站不允许浏览器直连 CORS）');
    }
  };

  const onSaveGlobal = async () => {
    const existing = await db.configs.where('scope').equals('global').first();
    await db.configs.put({
      id: existing?.id ?? 'global-config',
      scope: 'global',
      refId: null,
      memoryLimit: globalConfig.memoryLimit,
      prePrompt: globalConfig.prePrompt,
      postPrompt: globalConfig.postPrompt,
      prompt: globalConfig.prompt,
    });
    showToast('全局配置已保存');
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
    await savePreset({ providerId: presetProvider, model: presetModel.trim(), params, capabilities });
    setPresetOpen(false);
    setPresetModel('');
    await refresh();
    showToast('模型配置已保存');
  };

  const supportedFields: { key: keyof ModelParams; label: string; supported: boolean; step: number; min: number; max: number }[] = [
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
        <div className="text-[11px] text-slate-400">模型由你自己接入，数据全部留在本机</div>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
          <h2 className="mb-2 text-[13px] font-semibold text-slate-600">全局配置（对所有卡片生效）</h2>
          <div className="space-y-2 rounded-2xl border border-black/10 bg-white p-3">
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">记忆设定（保留条数）</div>
              <input type="number" className={inputClass} value={globalConfig.memoryLimit}
                onChange={(e) => setGlobalConfig({ ...globalConfig, memoryLimit: Number(e.target.value) })} />
            </label>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">提示词</div>
              <textarea className={inputClass} rows={4} value={globalConfig.prompt}
                onChange={(e) => setGlobalConfig({ ...globalConfig, prompt: e.target.value })} />
            </label>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">前置词</div>
              <textarea className={inputClass} rows={3} value={globalConfig.prePrompt}
                onChange={(e) => setGlobalConfig({ ...globalConfig, prePrompt: e.target.value })} />
            </label>
            <label className="block">
              <div className="mb-1 text-[12px] text-slate-500">后置词</div>
              <textarea className={inputClass} rows={3} value={globalConfig.postPrompt}
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
      </main>
    </div>
  );
}