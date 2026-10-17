import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, type ContextPreview } from '../../state/useSession';
import { useSettingFlag } from '../../state/useSetting';
import { useData } from '../../state/useData';
import { useNav } from '../../state/useNav';
import { updateSummaryText } from '../../core/storage/memoryStore';
import { listMods, setModEnabled } from '../../core/storage/modRepo';
import type { ModRecord } from '../../core/storage/types';
import { useBlobUrl } from '../cards/useAssetUrl';
import { resolveCardImages } from '../cards/cardAssets';
import { db } from '../../core/storage/db';
import type { ChatRecord } from '../../core/storage/types';
import MessageBubble from './MessageBubble';
import CardPagePanel from './CardPagePanel';
import Composer from './Composer';

function formatTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="block w-full whitespace-nowrap px-3.5 py-2.5 text-left text-slate-700 active:bg-black/5">
      {label}
    </button>
  );
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** 距底部多少 px 以內算「還貼著底部」。使用者往上滑超過這個距離就停止自動跟隨。 */
const FOLLOW_THRESHOLD = 48;

export default function PlayScreen() {
  const ready = useSession((s) => s.ready);
  const cardId = useSession((s) => s.cardId);
  const cardName = useSession((s) => s.cardName);
  const messages = useSession((s) => s.messages);
  const draft = useSession((s) => s.draft);
  const streaming = useSession((s) => s.streaming);
  const summarizing = useSession((s) => s.summarizing);
  const restoreInput = useSession((s) => s.restoreInput);
  const consumeRestoreInput = useSession((s) => s.consumeRestoreInput);
  const preview = useSession((s) => s.preview);
  const modelLabel = useSession((s) => s.modelLabel);
  const error = useSession((s) => s.error);
  const regexRules = useSession((s) => s.regexRules);
  const cardUiHtml = useSession((s) => s.cardUiHtml);
  const memories = useSession((s) => s.memories);
  const chatId = useSession((s) => s.chatId);
  const init = useSession((s) => s.init);
  const reload = useSession((s) => s.reload);
  const send = useSession((s) => s.send);
  const stop = useSession((s) => s.stop);
  const branchTo = useSession((s) => s.branchTo);
  const regenerate = useSession((s) => s.regenerate);
  const deleteMessage = useSession((s) => s.deleteMessage);
  const removeMemory = useSession((s) => s.removeMemory);
  const openChat = useSession((s) => s.openChat);
  const newChat = useSession((s) => s.newChat);
  const renameChat = useSession((s) => s.renameChat);
  const deleteChat = useSession((s) => s.deleteChat);
  const dataVersion = useData((s) => s.version);
  const [memoryOn, setMemoryOn] = useSettingFlag('summaryEnabled', true);
  const showToast = useNav((s) => s.showToast);
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [mods, setMods] = useState<ModRecord[]>([]);
  const modsOn = mods.filter((m) => m.enabled && m.content.trim()).length;

  const [pageOpen, setPageOpen] = useState(false);
  const [sheet, setSheet] = useState<'chats' | 'memory' | 'mods' | 'context' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [info, setInfo] = useState<ContextPreview | null>(null);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [editingChat, setEditingChat] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [follow, setFollow] = useState(true);
  /** 浮動鈕的方向：往上滾顯示「回到顶部」、往下滾顯示「回到底部」 */
  const [scrollHint, setScrollHint] = useState<'top' | 'bottom' | null>(null);
  const lastScrollTop = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const card = useSession((s) => s.card);
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const avatarText = cardName ? Array.from(cardName)[0] : 'AI';
  // 卡片自带的头像（聊天气泡旁边）；没有头像就用封面，两样都没有才退回「首字」
  const cardImages = resolveCardImages(card);
  const avatarUrl = useBlobUrl(cardImages.avatar?.bytes, cardImages.avatar?.mime);
  const hasMessages = messages.length > 0 || draft.length > 0;
  // 卡片打开时互动页占满聊天框；发出第一条消息后自动收起
  const showPage = Boolean(cardUiHtml) && (!hasMessages || pageOpen);

  useEffect(() => {
    void init();
  }, [init]);

  // 換庫（登入 / 登出）或同步拉進新資料之後，把畫面上的資料重讀一次
  useEffect(() => {
    if (dataVersion > 0) void reload();
  }, [dataVersion, reload]);

  // 上下文占用：跑一次本地组装（不发请求），数字与真正发送时同一套
  const refreshContext = useCallback(async () => {
    setInfo(await preview());
  }, [preview]);

  useEffect(() => {
    void refreshContext();
  }, [refreshContext, messages.length, draft, memories.length, chatId, dataVersion]);

  /**
   * 自動滾動 + 單一顆「回頂/回底」浮動鈕。
   * - 只有使用者在底部時才自動跟隨（AI 吐字不會把畫面一直往下拉）
   * - 往上滾 → 向上三角形「回到顶部」；往下滾 → 三角形轉成向下「回到底部」
   * - 到頂 / 到底就淡出，不擋內容；按鈕有陰影與漸變動畫
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
    const atTop = el.scrollTop <= 8;
    setFollow(atBottom);
    const prev = lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    if (el.scrollTop < prev - 2) {
      setScrollHint(atTop ? null : 'top');
    } else if (el.scrollTop > prev + 2) {
      setScrollHint(atBottom ? null : 'bottom');
    } else if (atTop || atBottom) {
      setScrollHint(null);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
    setFollow(true);
    setScrollHint(null);
  }, []);

  /** 回到最上面（找更早的内容时用） */
  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    lastScrollTop.current = 0;
    setFollow(false);
    setScrollHint(null);
  }, []);

  useEffect(() => {
    if (showPage || !follow) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, draft, follow, showPage]);

  const loadChats = useCallback(async () => {
    if (!cardId) return;
    const list = await db.chats.where('cardId').equals(cardId).toArray();
    setChats(list.sort((a, b) => b.updatedAt - a.updatedAt));
  }, [cardId]);

  const openSheet = async (kind: 'chats' | 'memory' | 'mods' | 'context') => {
    if (kind === 'chats') await loadChats();
    if (kind === 'mods') setMods(await listMods());
    if (kind === 'context') setInfo(await preview());
    setMenuOpen(false);
    setSheet(kind);
  };

  const commitRename = async (chatId: string) => {
    const title = titleDraft.trim();
    setEditingChat(null);
    if (title) await renameChat(chatId, title);
    await loadChats();
  };

  /** 本地已經有一則訊息在生成時，先顯示「等待吐字」而不是一片空白 */
  const waiting = streaming && draft.length === 0;

  return (
    <div className="relative flex h-full flex-col bg-[var(--dsh-bg)]">
      <header className="dsh-header sticky top-0 z-10 px-4 pb-2.5 pt-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-slate-800">{cardName || '加载中…'}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#34c759]" />
              <span className="truncate">{modelLabel}</span>
            </div>
          </div>
          {/* 右上角：+ 新对话、⋮ 菜单。图标不要边框、菜单宽度跟着文字走（使用者要求） */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              data-testid="play-new-chat"
              aria-label="新对话"
              disabled={streaming || summarizing}
              onClick={() => { setPageOpen(false); setMenuOpen(false); void newChat(); }}
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 active:bg-black/5 disabled:opacity-40"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <div className="relative">
              <button
                type="button"
                data-testid="play-menu"
                aria-label="更多"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 active:bg-black/5"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <circle cx="9" cy="3.5" r="1.5" fill="currentColor" />
                  <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                  <circle cx="9" cy="14.5" r="1.5" fill="currentColor" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  className="dsh-float absolute right-0 top-10 z-30 w-max min-w-[6.5rem] overflow-hidden rounded-2xl bg-white py-1 text-[13px] shadow-lg"
                  data-testid="play-menu-panel"
                >
                  {cardUiHtml && hasMessages && !pageOpen && (
                    <MenuItem label="互动页" onClick={() => { setPageOpen(true); setMenuOpen(false); }} />
                  )}
                  <MenuItem label="对话" onClick={() => void openSheet('chats')} />
                  <MenuItem label={`MOD${modsOn > 0 ? ' · ' + modsOn + ' 开' : ''}`} onClick={() => void openSheet('mods')} />
                  <MenuItem label={`记忆${memories.length > 0 ? ' · ' + memories.length : ''}`} onClick={() => void openSheet('memory')} />
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col">
        {showPage && cardUiHtml ? (
          <CardPagePanel
            html={cardUiHtml}
            title={cardName}
            onExit={hasMessages ? () => setPageOpen(false) : undefined}
          />
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={onScroll}
              data-testid="message-scroll"
              className="flex-1 overflow-y-auto py-2"
            >
              {ready &&
                messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    role={m.role}
                    raw={m.raw}
                    rules={regexRules}
                    avatarText={m.role === 'assistant' ? avatarText : undefined}
                    avatarUrl={m.role === 'assistant' ? (avatarUrl ?? undefined) : undefined}
                    showOptions={m.id === lastId && !draft && !streaming}
                    onOption={(t) => void send(t)}
                    actions={{
                      onCopy: () => { copyText(m.raw); showToast('已复制'); },
                      onRegenerate: m.role === 'assistant' ? () => void regenerate() : undefined,
                      onBranch: () => void branchTo(m.id),
                      onDelete: () => void deleteMessage(m.id),
                    }}
                  />
                ))}
              {draft && (
                <MessageBubble role="assistant" raw={draft} streaming showOptions={false} onOption={() => {}} avatarText={avatarText} avatarUrl={avatarUrl ?? undefined} />
              )}
              {waiting && (
                <div className="flex items-start gap-2 px-3 py-2" data-testid="waiting-hint">
                  <div className="dsh-avatar overflow-hidden">
                    {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : avatarText}
                  </div>
                  <div className="dsh-bubble flex items-center gap-2 px-3.5 py-3 text-slate-500">
                    <span className="flex gap-1">
                      <i className="dsh-dot" />
                      <i className="dsh-dot" />
                      <i className="dsh-dot" />
                    </span>
                    <span className="text-[12px]">正在等模型吐字，可以按「停止」或先打下一句</span>
                  </div>
                </div>
              )}
              {error && (
                <div className="mx-3 my-2 whitespace-pre-wrap rounded-2xl bg-red-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-red-600">
                  {error}
                </div>
              )}
              <div className="h-2" />
            </div>

            {/*
              单颗浮动圆钮（参考风月）：往上滚显示向上三角「回到顶部」，往下滚三角向左转成向下「回到底部」。
              有阴影、渐入渐出；到顶 / 到底时淡出。图标按钮里永远没有文字。
            */}
            <div className="pointer-events-none absolute bottom-3 right-3 z-10">
              <button
                type="button"
                aria-label={scrollHint === 'bottom' ? '回到底部' : '回到顶部'}
                data-testid={scrollHint === 'top' ? 'scroll-to-top' : scrollHint === 'bottom' ? 'scroll-to-bottom' : 'scroll-button'}
                onClick={scrollHint === 'bottom' ? scrollToBottom : scrollToTop}
                aria-hidden={scrollHint === null}
                className={
                  'pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-600 ' +
                  'shadow-[0_8px_24px_rgba(16,24,40,0.18)] transition-all duration-300 ease-out ' +
                  (scrollHint
                    ? 'translate-y-0 scale-100 opacity-100'
                    : 'pointer-events-none translate-y-2 scale-90 opacity-0')
                }
              >
                <svg
                  width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
                  className={'transition-transform duration-300 ease-out ' + (scrollHint === 'bottom' ? '-rotate-180' : 'rotate-0')}
                >
                  <path d="M8 3 L14 12 L2 12 Z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </>
        )}
      </main>

      <Composer
        draftKey={chatId ?? 'default'}
        disabled={!ready}
        streaming={streaming}
        summarizing={summarizing}
        contextPercent={info && info.budget > 0 && info.totalTokens > 0
          ? Math.max(1, Math.round((info.totalTokens / info.budget) * 100))
          : 0}
        restoreText={restoreInput}
        onConsumeRestore={consumeRestoreInput}
        onSend={(t) => void send(t)}
        onStop={stop}
        onOpenContext={() => void openSheet('context')}
      />

      {sheet && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/35" onClick={() => setSheet(null)}>
          <div className="dsh-sheet max-h-[70%] overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[15px] font-semibold text-slate-800">
                {sheet === 'chats' ? '对话列表'
                  : sheet === 'mods' ? 'MOD（下一轮立刻生效）'
                    : sheet === 'context' ? '上下文占用'
                      : '记忆库'}
              </div>
              <button type="button" className="dsh-chip" onClick={() => setSheet(null)}>关闭</button>
            </div>

            {sheet === 'context' && info && (
              <>
                {info.rows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between border-b border-black/5 py-2 text-[12px]">
                    <span className="text-slate-600">{row.label}</span>
                    <span className="text-slate-400">{formatTokens(row.tokens)} tok</span>
                  </div>
                ))}
                <div className="mt-2 flex items-center justify-between py-2 text-[12px] font-medium">
                  <span className="text-slate-700">合计</span>
                  <span className="text-slate-700">
                    {formatTokens(info.totalTokens)} / {formatTokens(info.budget)} tok
                    （{info.budget > 0 && info.totalTokens > 0
                      ? Math.max(1, Math.round((info.totalTokens / info.budget) * 100))
                      : 0}%）
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                  <div
                    className="h-full rounded-full bg-[#0072E3]"
                    style={{ width: `${Math.min(100, info.budget > 0 ? Math.round((info.totalTokens / info.budget) * 100) : 0)}%` }}
                  />
                </div>
                <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-slate-400">
                  <div>被裁掉：历史 {info.droppedHistory} 条 · 世界书 {info.droppedWorldbook} 条</div>
                  <div>记忆库：{info.summaryCount} 条摘要</div>
                  <div>
                    模式：{info.mode === 'recent' ? `只带最近 ${info.windowLimit} 条消息` : '全部带（按占用阈值主动压缩）'}
                    （可在设置里改）
                  </div>
                </div>
              </>
            )}

            {sheet === 'chats' && (
              <>
                <button
                  type="button"
                  className="dsh-btn mb-2 w-full py-2.5 text-[13px]"
                  onClick={() => { void newChat(); setSheet(null); }}
                >
                  新建对话
                </button>
                {chats.map((c) => (
                  <div key={c.id} className="dsh-card mb-2 px-3.5 py-2.5">
                    {editingChat === c.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(c.id); }}
                          className="dsh-input flex-1 px-3 py-2 text-[13px] outline-none"
                        />
                        <button type="button" className="dsh-btn px-3.5 py-2 text-[12px]" onClick={() => void commitRename(c.id)}>
                          保存
                        </button>
                      </div>
                    ) : (
                      /* 右侧图标按钮（参考图：铅笔＝改名、⋮＝删除），不再占一整行 */
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => { void openChat(c.id); setSheet(null); }}
                        >
                          <div className="flex items-center gap-2">
                            {c.id === useSession.getState().chatId && (
                              <span className="dsh-chip dsh-chip-active px-2 py-1 text-[10px]">当前</span>
                            )}
                            <span className="truncate text-[13px] text-slate-700">{c.title}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-400">
                            {new Date(c.updatedAt).toLocaleString('zh-CN')}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label={`改名 ${c.title}`}
                          className="shrink-0 rounded-full p-2 text-slate-400 active:bg-black/5"
                          onClick={() => { setEditingChat(c.id); setTitleDraft(c.title); }}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3 13h2.2l7-7-2.2-2.2-7 7V13z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                            <path d="M10.6 4.6l1.6-1.6 2.2 2.2-1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${c.title}`}
                          className="shrink-0 rounded-full p-2 text-slate-400 active:bg-black/5"
                          onClick={async () => {
                            await deleteChat(c.id);
                            await loadChats();
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                            <circle cx="8" cy="3.5" r="1.3" fill="currentColor" />
                            <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                            <circle cx="8" cy="12.5" r="1.3" fill="currentColor" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {chats.length === 0 && (
                  <div className="py-6 text-center text-[13px] text-slate-400">还没有对话</div>
                )}
              </>
            )}

            {sheet === 'mods' && (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-slate-500">
                  MOD 是接在系统提示词后面的一段提示词。这里改开关**下一轮回复立刻生效**，不用重开对话。
                </div>
                {mods.length === 0 && (
                  <div className="py-8 text-center text-[13px] text-slate-400">
                    还没有 MOD，到「设置 → MOD」新增一个
                  </div>
                )}
                {mods.map((m) => (
                  <div key={m.id} className="dsh-card mb-2 flex items-center justify-between gap-3 px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-slate-700">{m.name}</div>
                      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] text-slate-400">{m.content}</div>
                    </div>
                    <button
                      type="button"
                      aria-label={`切换 ${m.name}`}
                      aria-pressed={m.enabled}
                      onClick={async () => {
                        await setModEnabled(m.id, !m.enabled);
                        setMods(await listMods());
                      }}
                      className={'relative h-6 w-11 shrink-0 rounded-full transition ' + (m.enabled ? 'bg-[#0072E3]' : 'bg-black/15')}
                    >
                      <span className={'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ' + (m.enabled ? 'left-[22px]' : 'left-0.5')} />
                    </button>
                  </div>
                ))}
              </>
            )}

            {sheet === 'memory' && (
              <>
                <div className="dsh-card mb-3 p-3.5">
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-medium text-slate-700">记忆库（自动摘要）</div>
                    <button
                      type="button"
                      data-testid="memory-toggle"
                      aria-pressed={memoryOn}
                      onClick={() => setMemoryOn(!memoryOn)}
                      className={
                        'relative h-6 w-11 shrink-0 rounded-full transition ' +
                        (memoryOn ? 'bg-[#0072E3]' : 'bg-black/15')
                      }
                    >
                      <span
                        className={
                          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ' +
                          (memoryOn ? 'left-[22px]' : 'left-0.5')
                        }
                      />
                    </button>
                  </div>
                  <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                    开启后：掉出上下文的对话会**按对**（一条你的输入 + 一条 AI 回复）交给模型压成摘要，
                    存进这里，并在下一轮以「更早的对话摘要」回注 —— 让 AI 记得窗口外面发生过什么。
                    摘要分「用户 / 叙事」两段，AI 不会把你的选择当成自己写的。
                    关掉后：窗口外的内容不再记录（长对话会失忆）。
                  </div>
                </div>
                {!memoryOn && (
                  <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                    自动摘要已关闭，下面的条目不会再增加。
                  </div>
                )}
                {memories.length === 0 && (
                  <div className="py-8 text-center text-[13px] text-slate-400">
                    还没有摘要。聊到超出上下文条数时，更早的对话会自动压成摘要出现在这里。
                  </div>
                )}
                {memories.map((m) => (
                  <div key={m.id} className="dsh-card mb-2 px-3.5 py-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#0072e3]">
                        {m.dateLabel}
                        {m.rangeLabel ? ` · ${m.rangeLabel}` : ''}
                        {m.origin === 'merged' ? ' · 合并' : m.origin === 'local-skeleton' ? ' · 骨架（模型失败）' : m.origin === 'verbatim' ? ' · 原文保留（已是最短）' : ''}
                      </span>
                      <span className="flex gap-3">
                        <button
                          type="button"
                          className="text-slate-400"
                          onClick={() => { setEditingSummary(m.id); setSummaryDraft(m.text); }}
                        >
                          编辑
                        </button>
                        <button type="button" className="text-red-400" onClick={() => void removeMemory(m.id)}>删除</button>
                      </span>
                    </div>
                    {editingSummary === m.id ? (
                      <div className="mt-1.5 space-y-2">
                        <textarea
                          className="dsh-input w-full px-3 py-2 text-[12px] outline-none"
                          rows={5}
                          value={summaryDraft}
                          onChange={(e) => setSummaryDraft(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="dsh-btn flex-1 py-2 text-[12px]"
                            onClick={async () => {
                              await updateSummaryText(m.id, summaryDraft);
                              setEditingSummary(null);
                              showToast('摘要已更新');
                            }}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="rounded-xl border border-black/10 px-4 py-2 text-[12px] text-slate-500"
                            onClick={() => setEditingSummary(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{m.text}</div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}