import { useMemo } from 'react';
import { renderMessage } from '../../core/render/pipeline';
import Collapse from '../components/Collapse';
import OptionBar from '../components/OptionBar';

export default function MessageBubble({
  role, raw, onOption, showOptions, streaming,
}: {
  role: 'user' | 'assistant';
  raw: string;
  onOption: (text: string) => void;
  showOptions: boolean;
  streaming?: boolean;
}) {
  const result = useMemo(() => renderMessage(raw), [raw]);

  if (role === 'user') {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[#0072E3] px-3 py-2 text-[14px] leading-relaxed text-white">
          {raw}
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5">
      <div className="rounded-2xl bg-white px-3 py-2 text-[14px] leading-[1.75] text-slate-800 shadow-sm">
        {result.blocks.map((b, i) => {
          if (b.kind === 'collapse') {
            return (
              <Collapse key={i} summary={b.summary}>
                <div dangerouslySetInnerHTML={{ __html: b.html }} />
              </Collapse>
            );
          }
          if (b.kind === 'plot') {
            return <div key={i} className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: b.html }} />;
          }
          if (b.kind === 'options') {
            return showOptions ? <OptionBar key={i} items={b.items} onPick={onOption} disabled={streaming} /> : null;
          }
          return <div key={i} dangerouslySetInnerHTML={{ __html: b.html }} />;
        })}
        {streaming && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-blue-500 align-middle" />}
      </div>
    </div>
  );
}
