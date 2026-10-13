export default function OptionBar({ items, onPick, disabled }: {
  items: { key: string; text: string }[];
  onPick: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-2 space-y-1.5">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(it.key + '. ' + it.text)}
          className="w-full rounded-xl border border-blue-200 bg-blue-50/70 px-3 py-2 text-left text-[13px] leading-relaxed text-blue-800 active:bg-blue-100 disabled:opacity-50"
        >
          <span className="font-semibold">{it.key}. </span>
          {it.text}
        </button>
      ))}
    </div>
  );
}
