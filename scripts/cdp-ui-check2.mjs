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

// 0) 状态栏配色 / 底部导航尺寸 / 顶栏只留模型
report.chrome = await evaluate(`(() => {
  const body = getComputedStyle(document.body).backgroundColor;
  const nav = document.querySelector('nav');
  const navBtn = nav ? nav.querySelector('button') : null;
  const header = document.querySelector('header');
  return {
    bodyBg: body,
    navButtonHeight: navBtn ? Math.round(navBtn.getBoundingClientRect().height) : 0,
    headerHasContextText: header ? header.innerText.includes('上下文') : false,
    headerText: header ? header.innerText.replace(/\\s+/g, ' ').slice(0, 60) : '',
  };
})()`);

// 1) 上下文占用：输入框旁边的图标按钮（像 codex），按下才看明细
report.hud = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="context-button"]');
  const box = document.querySelector('textarea');
  if (!btn || !box) return { exists: false };
  const b = box.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  return {
    exists: true,
    betweenInputAndSend: r.left >= b.right - 1,
    ringText: btn.innerText.trim(),
  };
})()`);
await evaluate(`document.querySelector('[data-testid="context-button"]').click()`);
await sleep(500);
report.hudDetail = await evaluate(`(() => {
  const t = document.body.innerText;
  return {
    title: t.includes('上下文占用'),
    system: t.includes('系统提示词'),
    total: t.includes('合计'),
    hasPercent: /\\d+%/.test(t),
  };
})()`);
await shot('u3-hud');
await clickText('关闭');
await sleep(300);

// 1b) 顶栏四个入口收成一个菜单
report.menu = await evaluate(`(() => {
  const before = Boolean(document.querySelector('[data-testid="play-menu-panel"]'));
  document.querySelector('[data-testid="play-menu"]').click();
  return { closedBefore: !before };
})()`);
await sleep(400);
report.menu.items = await evaluate(`(() => {
  const p = document.querySelector('[data-testid="play-menu-panel"]');
  return p ? p.innerText.replace(/\\s+/g, ' ').trim() : '';
})()`);
await shot('u3-menu');
report.menuStyle = await evaluate(`(() => {
  const p = document.querySelector('[data-testid="play-menu-panel"]');
  const items = p ? [...p.querySelectorAll('button')] : [];
  const maxItem = items.reduce((m, b) => Math.max(m, b.scrollWidth), 0);
  return {
    panelWidth: p ? Math.round(p.getBoundingClientRect().width) : 0,
    maxItemWidth: Math.round(maxItem),
    itemCount: items.length,
  };
})()`);
await evaluate(`document.querySelector('[data-testid="play-menu"]').click()`);
await sleep(300);

// 1c) 圖示不要邊框（使用者要求）：上下文圖示與 ⋮ 菜單鈕都應該是無框的
report.iconStyle = await evaluate(`(() => {
  const pick = (el) => el ? {
    border: getComputedStyle(el).borderTopWidth,
    shadow: getComputedStyle(el).boxShadow,
  } : null;
  return {
    context: pick(document.querySelector('[data-testid="context-button"]')),
    menu: pick(document.querySelector('[data-testid="play-menu"]')),
    plus: pick(document.querySelector('[data-testid="play-new-chat"]')),
  };
})()`);

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
    triggerField: Boolean(document.querySelector('[aria-label="压缩触发阈值"]')),
    triggerHint: t.includes('压缩旧对话'),
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
const openViaMenu = async (label) => {
  await evaluate(`document.querySelector('[data-testid="play-menu"]').click()`);
  await sleep(300);
  await evaluate(`(() => {
    const p = document.querySelector('[data-testid="play-menu-panel"]');
    const item = [...p.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}));
    item.click();
    return true;
  })()`);
  await sleep(600);
};

report.afterChat = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="context-button"]');
  const ring = btn ? btn.innerText.trim() : '';
  return { ring, ringIsNumber: /^\\d+$/.test(ring), hasMemoryChip: document.body.innerText.includes('记忆') };
})()`);

// 打開記憶庫看摘要
await openViaMenu('记忆');
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

// 4) MOD 入口（现在在菜单里）
await openViaMenu('MOD');
await sleep(300);
report.modSheet = await evaluate(`(() => {
  const t = document.body.innerText;
  return { opened: t.includes('MOD（下一轮立刻生效）'), hint: t.includes('立刻生效') };
})()`);
await shot('u2-mod');
await clickText('关闭');
await sleep(300);

// 5) 單顆浮動鈕：往下滚 → 回到底部（向下三角）；往上滚 → 回到顶部（向上三角，向左旋转回来）
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  el.scrollTop = 0;
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  el.scrollTop = Math.min(600, el.scrollHeight - el.clientHeight);
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return el.scrollTop;
})()`);
await sleep(400);
report.scrollDown = await evaluate(`(() => {
  const bottom = document.querySelector('[data-testid="scroll-to-bottom"]');
  const top = document.querySelector('[data-testid="scroll-to-top"]');
  const btn = bottom;
  return {
    bottom: Boolean(bottom), top: Boolean(top),
    iconOnly: btn ? btn.textContent.trim() === '' : false,
    hasSvg: Boolean(btn && btn.querySelector('svg')),
    noBorder: btn ? getComputedStyle(btn).borderTopWidth === '0px' : false,
    hasShadow: btn ? getComputedStyle(btn).boxShadow !== 'none' : false,
  };
})()`);
await shot('u2-scroll-bottom');

await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  el.scrollTop = Math.max(0, el.scrollTop - 300);
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return el.scrollTop;
})()`);
await sleep(400);
report.scrollUp = await evaluate(`(() => {
  const top = document.querySelector('[data-testid="scroll-to-top"]');
  const bottom = document.querySelector('[data-testid="scroll-to-bottom"]');
  return {
    top: Boolean(top), bottom: Boolean(bottom),
    iconOnly: top ? top.textContent.trim() === '' : false,
    hasSvg: Boolean(top && top.querySelector('svg')),
  };
})()`);
await shot('u2-scroll-top');

// 5b) 右上角 + 按鈕：新增對話
const countChats = async () => evaluate(`(async () => {
  const req = indexedDB.open('dsh-roleplay');
  return new Promise((resolve) => {
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('chats', 'readonly');
      const c = tx.objectStore('chats').count();
      c.onsuccess = () => resolve(c.result);
      c.onerror = () => resolve(-1);
    };
    req.onerror = () => resolve(-1);
  });
})()`);
const chatsBefore = await countChats();
report.plusButton = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="play-new-chat"]');
  return { exists: Boolean(btn), iconOnly: btn ? btn.textContent.trim() === '' : false };
})()`);
await evaluate(`document.querySelector('[data-testid="play-new-chat"]').click()`);
await sleep(900);
report.plusButton.chatsBefore = chatsBefore;
report.plusButton.chatsAfter = await countChats();

// 6) 對話列表右側圖示 + 新對話從「對話N」開始命名（入口在 ⋮ 菜單裡）
await openViaMenu('对话');
await clickText('新建对话');
await sleep(1200);
// 「新建对话」会把面板关掉，重新打开才看得到列表
await openViaMenu('对话');
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
  report.chrome.bodyBg === 'rgb(255, 255, 255)' &&
  report.chrome.navButtonHeight >= 56 &&
  report.chrome.headerHasContextText === false &&
  report.hud.exists && report.hud.betweenInputAndSend &&
  report.afterChat.ringIsNumber &&
  report.hudDetail.title && report.hudDetail.system && report.hudDetail.total && report.hudDetail.hasPercent &&
  report.menu.closedBefore && /记忆/.test(report.menu.items) && /对话/.test(report.menu.items) &&
  report.menuStyle.panelWidth > 40 && report.menuStyle.panelWidth <= report.menuStyle.maxItemWidth + 40 &&
  report.iconStyle.context && report.iconStyle.context.border === '0px' && report.iconStyle.context.shadow === 'none' &&
  report.iconStyle.menu && report.iconStyle.menu.border === '0px' && report.iconStyle.menu.shadow === 'none' &&
  report.iconStyle.plus && report.iconStyle.plus.border === '0px' &&
  report.settings.contextSection && report.settings.modeRecent && report.settings.modeAll &&
  report.settings.contextLimit && report.settings.summaryToggle &&
  report.settings.triggerField && report.settings.triggerHint &&
  report.settings.modSection && report.settings.contextSizeSlider &&
  report.memorySheet.opened && report.memorySheet.summaryCount > 0 &&
  report.modSheet.opened && report.modSheet.hint &&
  report.scrollDown.bottom && !report.scrollDown.top &&
  report.scrollDown.iconOnly && report.scrollDown.hasSvg && report.scrollDown.noBorder && report.scrollDown.hasShadow &&
  report.scrollUp.top && !report.scrollUp.bottom && report.scrollUp.iconOnly && report.scrollUp.hasSvg &&
  report.plusButton.exists && report.plusButton.iconOnly &&
  report.plusButton.chatsAfter === report.plusButton.chatsBefore + 1 &&
  report.chatList.renameIcons > 0 && report.chatList.deleteIcons > 0 && report.chatList.svgIcons > 0 &&
  report.chatList.numberedName &&
  logs.length === 0;

console.log(JSON.stringify(report, null, 1));
ws.close();