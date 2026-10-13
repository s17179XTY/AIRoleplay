export default function OptionBar({ items, onPick, disabled }: {
  items: { key: string; text: string }[];
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3 space-y-2">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(it.key + '. ' + it.text)}
          style={{ borderRadius: 9999 }}
          className="dsh-card flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] leading-relaxed text-slate-700 transition active:scale-[0.99] disabled:opacity-50"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#eef5ff] text-[11px] font-semibold text-[#0072e3]">
            {it.key}
          </span>
          <span className="flex-1">{it.text}</span>
        </button>
      ))}
    </div>
  );
}
