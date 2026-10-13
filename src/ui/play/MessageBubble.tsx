import { useMemo, useState } from 'react';
import { renderMessage } from '../../core/render/pipeline';
import type { RegexRule } from '../../core/cards/regex';
import Collapse from '../components/Collapse';
import OptionBar from '../components/OptionBar';

export interface MessageActions {
  onRegenerate?: () => void;
  onBranch?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
}

export default function MessageBubble({
  role, raw, onOption, showOptions, streaming, rules, actions, avatarText,
}: {
  role: 'user' | 'assistant';
  raw: string;
  onOption: (text: string) => void;
  showOptions: boolean;
  streaming?: boolean;
  rules?: RegexRule[];
  actions?: MessageActions;
  avatarText?: string;
}) {
  const result = useMemo(() => renderMessage(raw, { rules }), [raw, rules]);
  const [showActions, setShowActions] = useState(false);

  if (role === 'user') {
    return (
      <div className="flex items-end justify-end gap-2 px-3 py-2">
        <div className="flex max-w-[78%] flex-col items-end">
          <button
            type="button"
            onClick={() => setShowActions((v) => !v)}
            className="dsh-bubble-user whitespace-pre-wrap px-3.5 py-2.5 text-left text-[14px] leading-relaxed"
          >
            {raw}
          </button>
          {showActions && (
            <div className="mt-1.5 flex gap-3 text-[11px] text-slate-400">
              {actions?.onCopy && <button type="button" onClick={actions.onCopy}>复制</button>}
              {actions?.onBranch && <button type="button" onClick={actions.onBranch}>从这里重开</button>}
              {actions?.onDelete && <button type="button" className="text-red-400" onClick={actions.onDelete}>删除</button>}
            </div>
          )}
        </div>
        <div className="dsh-avatar">你</div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <div className="dsh-avatar">{avatarText || 'AI'}</div>
      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setShowActions((v) => !v)}
          className="dsh-bubble block w-full px-3.5 py-3 text-left text-[14px] leading-[1.85] text-slate-800"
        >
          {result.blocks.map((b, i) => {
            if (b.kind === 'collapse') {
              return (
                <span key={i} className="block" onClick={(e) => e.stopPropagation()}>
                  <Collapse summary={b.summary}>
                    <span className="block" dangerouslySetInnerHTML={{ __html: b.html }} />
                  </Collapse>
                </span>
              );
            }
            if (b.kind === 'plot') {
              return <span key={i} className="block whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: b.html }} />;
            }
            if (b.kind === 'options') {
              return showOptions ? (
                <span key={i} className="block" onClick={(e) => e.stopPropagation()}>
                  <OptionBar items={b.items} onPick={onOption} disabled={streaming} />
                </span>
              ) : null;
            }
            return <span key={i} className="block" dangerouslySetInnerHTML={{ __html: b.html }} />;
          })}
          {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse rounded-full bg-[#0072e3] align-middle" />}
        </button>

        {showActions && !streaming && (
          <div className="mt-1.5 flex gap-3 pl-1 text-[11px] text-slate-400">
            {actions?.onCopy && <button type="button" onClick={actions.onCopy}>复制</button>}
            {actions?.onRegenerate && <button type="button" onClick={actions.onRegenerate}>重新生成</button>}
            {actions?.onBranch && <button type="button" onClick={actions.onBranch}>从这里重开</button>}
            {actions?.onDelete && <button type="button" className="text-red-400" onClick={actions.onDelete}>删除</button>}
          </div>
        )}
      </div>
    </div>
  );
}
