import { useEffect, useRef } from 'react';
import { useSession } from '../../state/useSession';
import MessageBubble from './MessageBubble';
import Composer from './Composer';

export default function PlayScreen() {
  const ready = useSession((s) => s.ready);
  const cardName = useSession((s) => s.cardName);
  const messages = useSession((s) => s.messages);
  const draft = useSession((s) => s.draft);
  const streaming = useSession((s) => s.streaming);
  const error = useSession((s) => s.error);
  const init = useSession((s) => s.init);
  const send = useSession((s) => s.send);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, draft]);

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;

  return (
    <div className="flex h-full flex-col bg-[#f2f2f7]">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-white/90 px-3 pb-2 pt-3 backdrop-blur">
        <div className="truncate text-[15px] font-semibold text-slate-800">{cardName || '加载中…'}</div>
        <div className="text-[11px] text-slate-400">本地演示卡 · mock 模型</div>
      </header>

      <main className="flex-1 overflow-y-auto py-2">
        {ready &&
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              role={m.role}
              raw={m.raw}
              showOptions={m.id === lastId && !draft && !streaming}
              onOption={(t) => void send(t)}
            />
          ))}
        {draft && (
          <MessageBubble role="assistant" raw={draft} streaming showOptions={false} onOption={() => {}} />
        )}
        {error && <div className="mx-3 my-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </main>

      <Composer disabled={streaming || !ready} onSend={(t) => void send(t)} />
    </div>
  );
}
