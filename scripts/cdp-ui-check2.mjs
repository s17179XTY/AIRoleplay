// 這一輪新功能的真實瀏覽器驗收：上下文 HUD、摘要、MOD 入口、圖示按鈕、對話列表圖示、console 零警告
// 用法：node scripts/cdp-ui-check2.mjs <debugPort> <url>
const PORT = process.argv[2] ?? '9352';
const APP = process.argv[3] ?? 'http://127.0.0.1:5173/';
const { writeFileSync } = await import('node:fs');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('NO_PAGE_TARGET'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const logs = [];
let seq = 0;
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/Warning:|Error:|validateDOMNesting/.test(text)) logs.push(`[${msg.params.type}] ${text.slice(0, 200)}`);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/${name}.png`, Buffer.from(s.data, 'base64'));
};
const clickText = (text, selector = 'button') => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'OK';
})()`);
const setText = (value) => evaluate(`(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(value)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value;
})()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP });
await sleep(3000);
logs.length = 0;

const report = {};

// 1) 上下文 HUD
report.hud = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="context-hud"]');
  return { exists: Boolean(el), text: el ? el.innerText.replace(/\\s+/g, ' ') : '' };
})()`);
await evaluate(`document.querySelector('[data-testid="context-hud"]').click()`);
await sleep(400);
report.hudDetail = await evaluate(`(() => {
  const t = document.body.innerText;
  return {
    title: t.includes('上下文占用'),
    system: t.includes('系统提示词'),
    total: t.includes('合计'),
    hasTokenBudget: /\\/\\s*[\\d.]+k? tok/.test(t),
  };
})()`);
await shot('u2-hud');
await clickText('关闭');
await sleep(300);

// 2) 改設定：只帶最近 4 條，然後聊 4 輪，看摘要庫
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('设置'));
  nav.click();
  return true;
})()`);
await sleep(700);
report.settings = await evaluate(`(() => {
  const t = document.body.innerText;
  return {
    contextSection: t.includes('上下文与记忆（对所有卡片生效）'),
    modeRecent: t.includes('只带最近 N 条'),
    modeAll: t.includes('全部带'),
    contextLimit: Boolean(document.querySelector('[aria-label="上下文条数"]')),
    summaryToggle: Boolean(document.querySelector('[aria-label="记忆托管开关"]')),
    modSection: t.includes('MOD（热插拔提示词）'),
  };
})()`);
// 「上下文大小」滑块在模型配置表单里（要点开「新增模型配置」才看得到）
await clickText('+ 新增模型配置');
await sleep(400);
report.settings.contextSizeSlider = await evaluate(`document.body.innerText.includes('上下文大小')`);
report.settings.presetEditButton = await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '编辑')`);
await clickText('取消');
await sleep(300);
// 把條數改成 4 並保存
await evaluate(`(() => {
  const input = document.querySelector('[aria-label="上下文条数"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '4');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);
await clickText('保存全局配置');
await sleep(500);
const savedLimit = await evaluate(`(async () => {
  const req = indexedDB.open('dsh-roleplay');
  return new Promise((resolve) => {
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readonly');
      const get = tx.objectStore('settings').get('contextMessageLimit');
      get.onsuccess = () => resolve(get.result ? get.result.value : null);
    };
    req.onerror = () => resolve('ERR');
  });
})()`);
report.savedLimit = savedLimit;
await shot('u2-settings');

// 3) 回首頁聊 4 輪 → 應該出現摘要
await evaluate(`(() => {
  const nav = [...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('游玩'));
  nav.click();
  return true;
})()`);
await sleep(800);
for (let i = 1; i <= 4; i += 1) {
  await setText('第' + i + '句');
  await clickText('发送');
  await sleep(2600);
}
report.afterChat = await evaluate(`(() => {
  const hud = document.querySelector('[data-testid="context-hud"]');
  return { hud: hud ? hud.innerText.replace(/\\s+/g, ' ') : '', hasMemoryChip: document.body.innerText.includes('记忆') };
})()`);

// 打開記憶庫看摘要
await evaluate(`(() => {
  const chip = [...document.querySelectorAll('header button')].find((b) => b.textContent.includes('记忆'));
  chip.click();
  return true;
})()`);
await sleep(600);
report.memorySheet = await evaluate(`(() => {
  const t = document.body.innerText;
  return {
    opened: t.includes('记忆库'),
    hasSummaryExplain: t.includes('按对') || t.includes('摘要'),
    summaryCount: (t.match(/第 \\d+–\\d+ 条/g) || []).length,
  };
})()`);
await shot('u2-memory');
await clickText('关闭');
await sleep(300);

// 4) MOD 入口
await evaluate(`(() => {
  const chip = [...document.querySelectorAll('header button')].find((b) => b.textContent.trim().startsWith('MOD'));
  chip.click();
  return true;
})()`);
await sleep(500);
report.modSheet = await evaluate(`(() => {
  const t = document.body.innerText;
  return { opened: t.includes('MOD（下一轮立刻生效）'), hint: t.includes('立刻生效') };
})()`);
await shot('u2-mod');
await clickText('关闭');
await sleep(300);

// 5) 往上滑 → 圖示按鈕
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  el.scrollTop = 0;
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return el.scrollTop;
})()`);
await sleep(400);
report.scrollIcons = await evaluate(`(() => {
  const top = document.querySelector('[data-testid="scroll-to-top"]');
  const bottom = document.querySelector('[data-testid="scroll-to-bottom"]');
  return {
    top: Boolean(top), bottom: Boolean(bottom),
    topIsIconOnly: top ? top.textContent.trim() === '' : false,
    bottomIsIconOnly: bottom ? bottom.textContent.trim() === '' : false,
    hasSvg: Boolean(bottom && bottom.querySelector('svg')),
  };
})()`);
await shot('u2-scroll-icons');

// 6) 對話列表右側圖示 + 新對話從「對話N」開始命名
await evaluate(`(() => {
  const chip = [...document.querySelectorAll('header button')].find((b) => b.textContent === '对话');
  chip.click();
  return true;
})()`);
await sleep(600);
await clickText('新建对话');
await sleep(1200);
// 「新建对话」会把面板关掉，重新打开才看得到列表
await evaluate(`(() => {
  const chip = [...document.querySelectorAll('header button')].find((b) => b.textContent === '对话');
  chip.click();
  return true;
})()`);
await sleep(700);
report.chatList = await evaluate(`(() => {
  const rename = document.querySelectorAll('[aria-label^="改名"]');
  const del = document.querySelectorAll('[aria-label^="删除"]');
  const svgs = document.querySelectorAll('[aria-label^="改名"] svg, [aria-label^="删除"] svg');
  return {
    renameIcons: rename.length, deleteIcons: del.length, svgIcons: svgs.length,
    numberedName: /对话\\d/.test(document.body.innerText),
  };
})()`);
await shot('u2-chatlist');

report.logs = logs;
report.pass =
  report.hud.exists && report.hud.text.includes('上下文') &&
  report.hudDetail.title && report.hudDetail.system && report.hudDetail.total &&
  report.settings.contextSection && report.settings.modeRecent && report.settings.modeAll &&
  report.settings.contextLimit && report.settings.summaryToggle &&
  report.settings.modSection && report.settings.contextSizeSlider &&
  report.memorySheet.opened && report.memorySheet.summaryCount > 0 &&
  report.modSheet.opened && report.modSheet.hint &&
  report.scrollIcons.top && report.scrollIcons.bottom &&
  report.scrollIcons.topIsIconOnly && report.scrollIcons.bottomIsIconOnly && report.scrollIcons.hasSvg &&
  report.chatList.renameIcons > 0 && report.chatList.deleteIcons > 0 && report.chatList.svgIcons > 0 &&
  report.chatList.numberedName &&
  logs.length === 0;

console.log(JSON.stringify(report, null, 1));
ws.close();
