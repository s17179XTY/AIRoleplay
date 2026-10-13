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
  role, raw, onOption, showOptions, streaming, rules, actions,
}: {
  role: 'user' | 'assistant';
  raw: string;
  onOption: (text: string) => void;
  showOptions: boolean;
  streaming?: boolean;
  rules?: RegexRule[];
  actions?: MessageActions;
}) {
  const result = useMemo(() => renderMessage(raw, { rules }), [raw, rules]);
  const [showActions, setShowActions] = useState(false);

  if (role === 'user') {
    return (
      <div className="flex flex-col items-end px-3 py-1.5">
        <button
          type="button"
          onClick={() => setShowActions((v) => !v)}
          className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[#0072E3] px-3 py-2 text-left leading-relaxed text-white"
        >
          {raw}
        </button>
        {showActions && (
          <div className="mt-1 flex gap-2 text-[11px] text-slate-400">
            {actions?.onCopy && <button type="button" onClick={actions.onCopy}>复制</button>}
            {actions?.onBranch && <button type="button" onClick={actions.onBranch}>从这里重开</button>}
            {actions?.onDelete && <button type="button" className="text-red-400" onClick={actions.onDelete}>删除</button>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5">
      <button
        type="button"
        onClick={() => setShowActions((v) => !v)}
        className="block w-full rounded-2xl bg-white px-3 py-2 text-left leading-[1.75] text-slate-800 shadow-sm"
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
        {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-blue-500 align-middle" />}
      </button>

      {showActions && !streaming && (
        <div className="mt-1 flex gap-3 text-[11px] text-slate-400">
          {actions?.onCopy && <button type="button" onClick={actions.onCopy}>复制</button>}
          {actions?.onRegenerate && <button type="button" onClick={actions.onRegenerate}>重新生成</button>}
          {actions?.onBranch && <button type="button" onClick={actions.onBranch}>从这里重开</button>}
          {actions?.onDelete && <button type="button" className="text-red-400" onClick={actions.onDelete}>删除</button>}
        </div>
      )}
    </div>
  );
}
