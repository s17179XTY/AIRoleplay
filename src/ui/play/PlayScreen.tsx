import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../state/useSession';
import { useSettingFlag } from '../../state/useSetting';
import { useData } from '../../state/useData';
import { db } from '../../core/storage/db';
import type { ChatRecord } from '../../core/storage/types';
import MessageBubble from './MessageBubble';
import CardPagePanel from './CardPagePanel';
import Composer from './Composer';

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** 距底部多少 px 以內算「還貼著底部」。使用者往上滑超過這個距離就停止自動跟隨。 */
const FOLLOW_THRESHOLD = 48;

export default function PlayScreen() {
  const ready = useSession((s) => s.ready);
  const cardId = useSession((s) => s.cardId);
  const cardName = useSession((s) => s.cardName);
  const modelLabel = useSession((s) => s.modelLabel);
  const messages = useSession((s) => s.messages);
  const draft = useSession((s) => s.draft);
  const streaming = useSession((s) => s.streaming);
  const error = useSession((s) => s.error);
  const regexRules = useSession((s) => s.regexRules);
  const cardUiHtml = useSession((s) => s.cardUiHtml);
  const memories = useSession((s) => s.memories);
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
  const [memoryOn, setMemoryOn] = useSettingFlag('memoryEnabled', true);

  const [pageOpen, setPageOpen] = useState(false);
  const [sheet, setSheet] = useState<'chats' | 'memory' | null>(null);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [editingChat, setEditingChat] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const avatarText = cardName ? Array.from(cardName)[0] : 'AI';
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

  /**
   * 自動滾動：只有在「使用者還在底部」時才跟。
   * 以前是無條件 scrollIntoView，AI 一直吐字就一直把畫面往下拉，根本來不及讀
   * ——所以現在使用者一往上滑就停止跟隨，並出現「回到底部」。
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setFollow(true);
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

  const openSheet = async (kind: 'chats' | 'memory') => {
    if (kind === 'chats') await loadChats();
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
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#34c759]" />
              <span className="truncate">{modelLabel}</span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {cardUiHtml && hasMessages && !pageOpen && (
              <button type="button" className="dsh-chip" onClick={() => setPageOpen(true)}>互动页</button>
            )}
            <button type="button" className="dsh-chip" onClick={() => void openSheet('chats')}>对话</button>
            <button type="button" className="dsh-chip" onClick={() => void openSheet('memory')}>
              记忆{memories.length > 0 ? ' ' + memories.length : ''}
            </button>
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
                    showOptions={m.id === lastId && !draft && !streaming}
                    onOption={(t) => void send(t)}
                    actions={{
                      onCopy: () => copyText(m.raw),
                      onRegenerate: m.role === 'assistant' ? () => void regenerate() : undefined,
                      onBranch: () => void branchTo(m.id),
                      onDelete: () => void deleteMessage(m.id),
                    }}
                  />
                ))}
              {draft && (
                <MessageBubble role="assistant" raw={draft} streaming showOptions={false} onOption={() => {}} avatarText={avatarText} />
              )}
              {waiting && (
                <div className="flex items-start gap-2 px-3 py-2" data-testid="waiting-hint">
                  <div className="dsh-avatar">{avatarText}</div>
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

            {!follow && (
              <button
                type="button"
                onClick={scrollToBottom}
                data-testid="scroll-to-bottom"
                className="dsh-float absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-[rgba(20,24,33,0.82)] px-3.5 py-2 text-[12px] text-white backdrop-blur"
              >
                回到底部
              </button>
            )}
          </>
        )}
      </main>

      <Composer
        disabled={!ready}
        streaming={streaming}
        onSend={(t) => void send(t)}
        onStop={stop}
      />

      {sheet && (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/35" onClick={() => setSheet(null)}>
          <div className="dsh-sheet max-h-[70%] overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[15px] font-semibold text-slate-800">{sheet === 'chats' ? '对话列表' : '记忆库'}</div>
              <button type="button" className="dsh-chip" onClick={() => setSheet(null)}>关闭</button>
            </div>

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
                      <>
                        <button
                          type="button"
                          className="w-full text-left"
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
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="dsh-chip"
                            onClick={() => { setEditingChat(c.id); setTitleDraft(c.title); }}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="dsh-chip"
                            style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.22)' }}
                            onClick={async () => {
                              await deleteChat(c.id);
                              await loadChats();
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {chats.length === 0 && (
                  <div className="py-6 text-center text-[13px] text-slate-400">还没有对话</div>
                )}
              </>
            )}

            {sheet === 'memory' && (
              <>
                <div className="dsh-card mb-3 p-3.5">
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-medium text-slate-700">记忆托管</div>
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
                    开启后，AI 回复里的「近期记忆 / 永久记忆」区块会被自动收集起来，
                    满约定条数（默认 6 条，可在设置里改）就归档成永久记忆，并在下一轮提示词里回注，
                    让 AI 记得之前发生过什么。关掉后记忆区块只当作普通文字显示，不再解析、也不再回注。
                  </div>
                </div>
                {!memoryOn && (
                  <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                    记忆托管已关闭，下面的条目不会再更新。
                  </div>
                )}
                {memories.length === 0 && (
                  <div className="py-8 text-center text-[13px] text-slate-400">还没有记忆，聊几轮就会自动归档</div>
                )}
                {memories.map((m) => (
                  <div key={m.id} className="dsh-card mb-2 px-3.5 py-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className={m.tier === 'permanent' ? 'text-[#0072e3]' : 'text-slate-400'}>
                        {m.tier === 'permanent' ? '永久记忆' : '近期记忆'} · {m.dateLabel}
                      </span>
                      <button type="button" className="text-red-400" onClick={() => void removeMemory(m.id)}>删除</button>
                    </div>
                    <div className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{m.text}</div>
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
