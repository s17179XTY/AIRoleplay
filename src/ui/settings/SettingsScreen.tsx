export default function SettingsScreen() {
  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-white/90 px-3 pb-2 pt-3 backdrop-blur">
        <div className="text-[15px] font-semibold text-slate-800">设置</div>
      </header>
      <main className="flex-1 overflow-y-auto px-3 py-3 text-[13px] text-slate-500">
        模型接入与自定义配置将在下一步接入。
      </main>
    </div>
  );
}
