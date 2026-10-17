// 真實瀏覽器驗收：字級即時生效、輸入框下方不留空位、停止生成、等待提示、滾動可控、記憶區塊顯示、DOM 合法
// 用法：node shots/cdp-ui-check.mjs <debugPort> <url>
const PORT = process.argv[2] ?? '9351';
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
    if (text.includes('validateDOMNesting') || text.includes('Warning:')) logs.push(`[${msg.params.type}] ${text.slice(0, 220)}`);
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

/** 依「包含某段文字」找按鈕並真的點下去 */
const clickByText = (text, selector = 'button') => evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'OK';
})()`);

const clickByTestId = (id) => evaluate(`(() => {
  const el = document.querySelector('[data-testid="' + ${JSON.stringify(id)} + '"]');
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'OK';
})()`);

const setTextarea = (value) => evaluate(`(() => {
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
// Runtime.enable 會回放這個 target 之前的 console 訊息，導覽後先清空才不會誤判
logs.length = 0;

const report = {};

const readFont = () => evaluate(`(() => {
  const root = getComputedStyle(document.documentElement).getPropertyValue('--dsh-fs').trim();
  const bubbles = [...document.querySelectorAll('.dsh-bubble')];
  return { cssVar: root, bubble: bubbles.length ? getComputedStyle(bubbles[bubbles.length - 1]).fontSize : null };
})()`);
report.fontBefore = await readFont();

// ---------- 輸入框下方留白（Composer 內部底距 + 到導航的距離） ----------
report.composerGap = await evaluate(`(() => {
  const input = document.querySelector('.dsh-input');
  const nav = document.querySelector('nav.dsh-tabbar');
  const composer = input.closest('.dsh-tabbar');
  const a = input.getBoundingClientRect(), b = nav.getBoundingClientRect(), c = composer.getBoundingClientRect();
  return {
    gapInsideComposer: Math.round(c.bottom - a.bottom),
    gapToNav: Math.round(b.top - c.bottom),
    navPaddingBottom: Math.round(parseFloat(getComputedStyle(nav).paddingBottom) * 10) / 10,
    inputPaddingBottom: Math.round(parseFloat(getComputedStyle(composer).paddingBottom) * 10) / 10,
  };
})()`);

// ---------- 字級：在設定頁點「大」，切回遊玩頁不重新載入就要生效 ----------
await clickByText('设置', 'nav button');
await sleep(700);
report.settingsVisible = await evaluate(`document.body.innerText.includes('正文字号')`);
report.fontSettingText = await evaluate(`(() => {
  const el = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === '正文字号');
  return el ? el.textContent.trim() : null;
})()`);
await shot('ui-settings');
await clickByText('大', 'button');
await sleep(400);
report.fontAfterClick = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--dsh-fs').trim()`);
await clickByText('游玩', 'nav button');
await sleep(900);
report.fontAfterSwitchBack = await readFont();
report.bubbleFont = await evaluate(`(() => {
  const b = document.querySelector('.dsh-bubble');
  return b ? getComputedStyle(b).fontSize : null;
})()`);

// ---------- 記憶庫面板的開關與說明（入口收在 ⋮ 菜單裡） ----------
await clickByTestId('play-menu');
await sleep(300);
await clickByText('记忆');
await sleep(500);
report.memorySheet = await evaluate(`(() => {
  const toggle = document.querySelector('[data-testid="memory-toggle"]');
  const text = document.body.innerText;
  return {
    hasToggle: Boolean(toggle),
    pressed: toggle ? toggle.getAttribute('aria-pressed') : null,
    explains: text.includes('记忆库') && text.includes('按对') && text.includes('回注') && text.includes('关掉后'),
  };
})()`);
await shot('ui-memory-sheet');
await clickByText('关闭');
await sleep(400);

// ---------- 送出訊息：觀察停止鈕與等待提示（用 observer 抓瞬間狀態） ----------
await evaluate(`(() => {
  window.__probe = { stop: false, waiting: false };
  window.__obs = new MutationObserver(() => {
    if (document.querySelector('[data-testid="composer-stop"]')) window.__probe.stop = true;
    if (document.querySelector('[data-testid="waiting-hint"]')) window.__probe.waiting = true;
  });
  window.__obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  return true;
})()`);

await setTextarea('你好');
await clickByText('发送');
await sleep(250);
report.whileStreaming = await evaluate(`(() => ({
  stop: Boolean(document.querySelector('[data-testid="composer-stop"]')),
  cursor: Boolean(document.querySelector('.animate-pulse')),
  draftLen: (useSessionDraft = document.querySelector('.dsh-bubble') ? document.querySelector('.dsh-bubble').innerText.length : 0),
}))()`);
report.probe = await evaluate(`window.__probe`);
await shot('ui-streaming');
await sleep(2500);

report.afterDone = await evaluate(`(() => {
  const bubbles = [...document.querySelectorAll('.dsh-bubble')];
  const last = bubbles[bubbles.length - 1];
  return {
    bubbleCount: bubbles.length,
    fontSize: last ? getComputedStyle(last).fontSize : null,
    lastText: last ? last.innerText.slice(0, 80) : '',
    hasMemoryBlock: document.body.innerText.includes('近期记忆'),
    nestedButtons: document.querySelectorAll('button button').length,
  };
})()`);
await shot('ui-after-done');

// ---------- 多送幾輪把聊天撐長，再驗滾動可控 ----------
for (let i = 0; i < 2; i += 1) {
  await setTextarea('继续 ' + (i + 1));
  await clickByText('发送');
  await sleep(2600);
}
report.scrollable = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, canScroll: el.scrollHeight - el.clientHeight > 100 };
})()`);

// 使用者往上滑：不該被自動拉回底部，並出現「回到底部」
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 300);
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return el.scrollTop;
})()`);
await sleep(400);
report.afterScrollUp = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  return {
    scrollTop: Math.round(el.scrollTop),
    // 往上滚 → 显示向上的「回到顶部」
    topButton: Boolean(document.querySelector('[data-testid="scroll-to-top"]')),
    bottomButton: Boolean(document.querySelector('[data-testid="scroll-to-bottom"]')),
  };
})()`);
await shot('ui-scroll-lock');

// 生成中不該把畫面拉回底部
await setTextarea('滑上去之后再来一句');
await clickByText('发送');
await sleep(1200);
report.duringStreamScroll = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  return { scrollTop: Math.round(el.scrollTop), topButton: Boolean(document.querySelector('[data-testid="scroll-to-top"]')) };
})()`);
await sleep(2500);

// 按「回到顶部」要回到最上面；再往下滚会出现「回到底部」，按了回到最底
report.backToTop = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="scroll-to-top"]');
  if (!btn) return { clicked: false };
  btn.click();
  const el = document.querySelector('[data-testid="message-scroll"]');
  return { clicked: true, atTop: el.scrollTop <= 2 };
})()`);
await sleep(300);
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  el.scrollTop = Math.min(600, el.scrollHeight - el.clientHeight);
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
  return el.scrollTop;
})()`);
await sleep(300);
report.backToBottom = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="scroll-to-bottom"]');
  if (!btn) return { clicked: false };
  btn.click();
  const el = document.querySelector('[data-testid="message-scroll"]');
  return { clicked: true, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 };
})()`);
await shot('ui-final');

report.logs = logs;
report.pass =
  ['14px', '16px', '18px', '20px'].includes(report.fontBefore.cssVar) &&
  report.settingsVisible === true &&
  report.fontSettingText === '正文字号' &&
  report.fontAfterClick === '18px' &&
  report.fontAfterSwitchBack.cssVar === '18px' &&
  report.afterDone.fontSize === '18px' &&
  report.composerGap.gapInsideComposer <= 6 &&
  report.composerGap.gapToNav === 0 &&
  report.memorySheet.hasToggle &&
  report.memorySheet.explains &&
  report.probe.stop &&
  report.probe.waiting &&
  report.afterDone.bubbleCount >= 1 &&
  report.afterDone.hasMemoryBlock &&
  report.afterDone.nestedButtons === 0 &&
  report.scrollable.canScroll &&
  report.afterScrollUp.topButton && !report.afterScrollUp.bottomButton &&
  report.duringStreamScroll.topButton &&
  report.backToTop.clicked && report.backToTop.atTop &&
  report.backToBottom.clicked && report.backToBottom.atBottom &&
  logs.length === 0;

console.log(JSON.stringify(report, null, 1));
ws.close();