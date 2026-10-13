import { useEffect, useMemo, useState } from 'react';
import { loadCardPackage, saveCardPackage } from '../../core/storage/cardRepo';
import type { CardPackage } from '../../core/cards/package';
import { draftToPackage, newRegexScript, newWorldbookEntry, packageToDraft, type CardDraft } from './draft';
import { useNav } from '../../state/useNav';
import { useSession } from '../../state/useSession';

type Section = 'basic' | 'prompts' | 'worldbook' | 'regex' | 'ui';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'basic', label: '基本' },
  { key: 'prompts', label: '提示词' },
  { key: 'worldbook', label: '世界书' },
  { key: 'regex', label: '正则' },
  { key: 'ui', label: '界面' },
];

const inputClass = 'dsh-input w-full px-3.5 py-2.5 text-[13px] outline-none focus:border-[#0072e3]';

export default function CardEditorScreen({ cardId }: { cardId: string }) {
  const [base, setBase] = useState<CardPackage | null>(null);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [section, setSection] = useState<Section>('basic');
  const closeEditor = useNav((s) => s.closeEditor);
  const showToast = useNav((s) => s.showToast);
  const reloadCard = useSession((s) => s.reloadCard);

  useEffect(() => {
    void (async () => {
      const pkg = await loadCardPackage(cardId);
      if (!pkg) {
        showToast('卡片不存在');
        closeEditor();
        return;
      }
      setBase(pkg);
      setDraft(packageToDraft(pkg));
    })();
  }, [cardId, closeEditor, showToast]);

  const patchJson = useMemo(
    () => (patch: Partial<CardDraft['json']>) =>
      setDraft((d) => (d ? { ...d, json: { ...d.json, ...patch } } : d)),
    [],
  );

  if (!draft || !base) {
    return <div className="flex h-full items-center justify-center text-[13px] text-slate-400">加载中…</div>;
  }

  const onSave = async () => {
    const pkg = draftToPackage(draft, base);
    const id = await saveCardPackage(pkg);
    setBase(pkg);
    await reloadCard();
    showToast('已保存');
    if (id !== cardId) closeEditor();
  };

  return (
    <div className="flex h-full flex-col">
      <header className="dsh-header sticky top-0 z-10 px-4 pb-2.5 pt-3.5">
        <div className="flex items-center justify-between">
          <button type="button" onClick={closeEditor} className="dsh-chip">返回</button>
          <div className="truncate px-2 text-[14px] font-semibold text-slate-800">{draft.json.name || '未命名卡片'}</div>
          <button type="button" onClick={() => void onSave()} className="dsh-btn px-4 py-2 text-[12px]">保存</button>
        </div>
      </header>

      <div className="flex gap-1 overflow-x-auto border-b border-black/5 bg-white px-2 py-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            className={
              'dsh-chip shrink-0 ' +
              (section === s.key ? 'dsh-chip-active' : '')
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {section === 'basic' && (
          <>
            <Field label="卡片名">
              <input className={inputClass} value={draft.json.name}
                onChange={(e) => patchJson({ name: e.target.value })} />
            </Field>
            <Field label="作者">
              <input className={inputClass} value={draft.json.author}
                onChange={(e) => patchJson({ author: e.target.value })} />
            </Field>
            <Field label="简介（也会作为角色简介注入提示词）">
              <textarea className={inputClass} rows={3} value={draft.json.description}
                onChange={(e) => patchJson({ description: e.target.value })} />
            </Field>
            <Field label="标签（逗号分隔）">
              <input className={inputClass} value={draft.json.tags.join(',')}
                onChange={(e) => patchJson({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            </Field>
            <Field label="主人公设定">
              <textarea className={inputClass} rows={4} value={draft.json.persona.intro}
                onChange={(e) => patchJson({ persona: { ...draft.json.persona, intro: e.target.value } })} />
            </Field>
            <Field label="前情提要">
              <textarea className={inputClass} rows={3} value={draft.json.scenario}
                onChange={(e) => patchJson({ scenario: e.target.value })} />
            </Field>
            <Field label="开场白（支持 HTML，可留空）">
              <textarea className={inputClass} rows={5} value={draft.json.firstMessage}
                onChange={(e) => patchJson({ firstMessage: e.target.value })} />
            </Field>
          </>
        )}

        {section === 'prompts' && (
          <>
            <Field label="前置词（最先注入）">
              <textarea className={inputClass} rows={5} value={draft.json.prompts.pre}
                onChange={(e) => patchJson({ prompts: { ...draft.json.prompts, pre: e.target.value } })} />
            </Field>
            <Field label="提示词（主系统提示）">
              <textarea className={inputClass} rows={10} value={draft.json.prompts.prompt}
                onChange={(e) => patchJson({ prompts: { ...draft.json.prompts, prompt: e.target.value } })} />
            </Field>
            <Field label="后置词（历史之后注入）">
              <textarea className={inputClass} rows={5} value={draft.json.prompts.post}
                onChange={(e) => patchJson({ prompts: { ...draft.json.prompts, post: e.target.value } })} />
            </Field>
          </>
        )}

        {section === 'worldbook' && (
          <>
            {draft.worldbook.map((entry, i) => (
              <div key={entry.id} className="dsh-card p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-slate-600">条目 {i + 1}</span>
                  <button type="button" className="text-[12px] text-red-500"
                    onClick={() => setDraft({ ...draft, worldbook: draft.worldbook.filter((_, j) => j !== i) })}>
                    删除
                  </button>
                </div>
                <input className={inputClass} placeholder="关键词（逗号分隔）" value={entry.keys.join(',')}
                  onChange={(e) => {
                    const next = [...draft.worldbook];
                    next[i] = { ...entry, keys: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) };
                    setDraft({ ...draft, worldbook: next });
                  }} />
                <textarea className={inputClass + ' mt-2'} rows={3} placeholder="条目内容" value={entry.content}
                  onChange={(e) => {
                    const next = [...draft.worldbook];
                    next[i] = { ...entry, content: e.target.value };
                    setDraft({ ...draft, worldbook: next });
                  }} />
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-slate-500">
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={entry.constant}
                      onChange={(e) => {
                        const next = [...draft.worldbook];
                        next[i] = { ...entry, constant: e.target.checked };
                        setDraft({ ...draft, worldbook: next });
                      }} />常驻
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={entry.recursive}
                      onChange={(e) => {
                        const next = [...draft.worldbook];
                        next[i] = { ...entry, recursive: e.target.checked };
                        setDraft({ ...draft, worldbook: next });
                      }} />递归
                  </label>
                  <label className="flex items-center gap-1">
                    位置
                    <select className="rounded-lg border border-black/10 px-1 py-0.5" value={entry.position}
                      onChange={(e) => {
                        const next = [...draft.worldbook];
                        next[i] = { ...entry, position: e.target.value === 'after-char' ? 'after-char' : 'before-char' };
                        setDraft({ ...draft, worldbook: next });
                      }}>
                      <option value="before-char">角色定义前</option>
                      <option value="after-char">角色定义后</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    顺序
                    <input type="number" className="w-14 rounded-lg border border-black/10 px-1 py-0.5" value={entry.order}
                      onChange={(e) => {
                        const next = [...draft.worldbook];
                        next[i] = { ...entry, order: Number(e.target.value) };
                        setDraft({ ...draft, worldbook: next });
                      }} />
                  </label>
                </div>
              </div>
            ))}
            <button type="button" className="dsh-btn-ghost w-full border-dashed py-2.5 text-[13px]"
              onClick={() => setDraft({ ...draft, worldbook: [...draft.worldbook, newWorldbookEntry(draft.worldbook.length)] })}>
              + 新增世界书条目
            </button>
          </>
        )}

        {section === 'regex' && (
          <>
            {draft.regex.map((script, i) => (
              <div key={script.id} className="dsh-card p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <input className="text-[12px] font-medium text-slate-600 outline-none" value={script.name}
                    onChange={(e) => {
                      const next = [...draft.regex];
                      next[i] = { ...script, name: e.target.value };
                      setDraft({ ...draft, regex: next });
                    }} />
                  <button type="button" className="text-[12px] text-red-500"
                    onClick={() => setDraft({ ...draft, regex: draft.regex.filter((_, j) => j !== i) })}>
                    删除
                  </button>
                </div>
                <input className={inputClass} placeholder="匹配规则（正则内容本身，不写 /.../g）" value={script.pattern}
                  onChange={(e) => {
                    const next = [...draft.regex];
                    next[i] = { ...script, pattern: e.target.value };
                    setDraft({ ...draft, regex: next });
                  }} />
                <input className={inputClass + ' mt-2'} placeholder="替换文本（支持 $1 $2 与 HTML，留空为删除）" value={script.replacement}
                  onChange={(e) => {
                    const next = [...draft.regex];
                    next[i] = { ...script, replacement: e.target.value };
                    setDraft({ ...draft, regex: next });
                  }} />
                <div className="mt-2 flex items-center gap-3 text-[12px] text-slate-500">
                  <label className="flex items-center gap-1">
                    修饰符
                    <input className="w-16 rounded-lg border border-black/10 px-1 py-0.5" value={script.flags}
                      onChange={(e) => {
                        const next = [...draft.regex];
                        next[i] = { ...script, flags: e.target.value };
                        setDraft({ ...draft, regex: next });
                      }} />
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={script.enabled}
                      onChange={(e) => {
                        const next = [...draft.regex];
                        next[i] = { ...script, enabled: e.target.checked };
                        setDraft({ ...draft, regex: next });
                      }} />启用
                  </label>
                </div>
              </div>
            ))}
            <button type="button" className="dsh-btn-ghost w-full border-dashed py-2.5 text-[13px]"
              onClick={() => setDraft({ ...draft, regex: [...draft.regex, newRegexScript(draft.regex.length)] })}>
              + 新增正则规则
            </button>
          </>
        )}

        {section === 'ui' && (
          <>
            <Field label="交互界面 HTML（沙箱运行，勾选后由模板生成提示词）">
              <textarea className={inputClass + ' font-mono text-[11px]'} rows={14} value={draft.uiHtml}
                onChange={(e) => setDraft({ ...draft, uiHtml: e.target.value })} />
            </Field>
            <Field label="提示词模板（{{f:字段名}} 取字段值，{{?字段名}}…{{/字段名}} 条件段）">
              <textarea className={inputClass + ' font-mono text-[11px]'} rows={10} value={draft.template}
                onChange={(e) => setDraft({ ...draft, template: e.target.value })} />
            </Field>
          </>
        )}
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] text-slate-500">{label}</div>
      {children}
    </label>
  );
}
