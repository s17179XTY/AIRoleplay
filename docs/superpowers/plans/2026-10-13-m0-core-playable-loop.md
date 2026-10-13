# M0：核心可玩闭环 实施计划（工程骨架 + 四内核最小可用 + 游玩页）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让 npm run dev 打开就是一个手机版 AI 角色扮演应用：内置一张演示卡，点「开始游玩」后由 mock 模型流式输出带折叠状态栏与 A–F 选项的回复，点选项即可继续下一轮。

**Architecture:** 四内核分层。本计划实现「存储内核 + 装配内核 + 渲染内核 + 适配内核」的最小可用版本，以及消费它们的手机版游玩页。卡片正文以 zip 虚拟文件系统模型存储，但本计划先用内置演示卡（M1 再做 zip 导入导出）。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind CSS v4 + Zustand + Dexie + DOMPurify + Vitest + fake-indexeddb + jsdom。

**Spec:** docs/superpowers/specs/2026-10-13-fengyue-like-roleplay-app-design.md

## Global Constraints

- 包管理器用 npm；Node 24 / npm 11 已就绪。
- 不用任何需要 Node 运行时的库；全部代码可在浏览器运行。
- src/core/ 下四个内核不得 import React、不得 import 任何 ui/ 或 state/ 模块。
- messages.raw 一旦落库永不修改。
- 所有新文件用 LF 换行、UTF-8、TS strict。
- 命令统一在仓库根目录执行（工作区：D:\AI\DSH APP\AI角色扮演-deepseek）。
- 每个任务结束必须 git commit，提交信息用中文，格式 feat:/test:/chore:。

## File Structure

```
package.json                     依赖与脚本
index.html / vite.config.ts      Vite + Tailwind v4
tsconfig.json                    strict TS
src/main.tsx / src/App.tsx       入口与外壳
src/index.css                    Tailwind 入口 + 手机端基础样式
src/core/storage/types.ts        全部 Dexie 记录的 TS 类型
src/core/storage/db.ts           Dexie schema v1
src/core/storage/seed.ts         内置演示卡（dsh-card/1）
src/core/assembler/types.ts      PromptEntry / AssembleInput
src/core/assembler/macros.ts     宏替换
src/core/assembler/budget.ts     token 估算与裁剪
src/core/assembler/worldbook.ts  世界书触发
src/core/assembler/assemble.ts   条目 → 排序 → 裁剪 → 逻辑消息数组
src/core/render/extract.ts       思维链 / 记忆 / 选项 提取
src/core/render/sanitize.ts      DOMPurify 白名单
src/core/render/pipeline.ts      渲染管线编排
src/core/providers/types.ts      ProviderAdapter / StreamEvent / Capability
src/core/providers/sse.ts        SSE 分片解析
src/core/providers/mock.ts       mock 适配器（演示用）
src/core/providers/openai.ts     OpenAI 兼容适配器
src/state/useSession.ts          Zustand 会话 store
src/ui/play/PlayScreen.tsx       游玩页
src/ui/play/MessageBubble.tsx    单条消息（折叠面板与选项）
src/ui/play/Composer.tsx         输入区
src/ui/components/Collapse.tsx   折叠面板组件
src/ui/components/OptionBar.tsx  A–F 选项按钮
src/test/setup.ts                测试环境（fake-indexeddb）
```

---

### Task 1: 工程骨架

**Files:**
- Create: package.json, index.html, vite.config.ts, tsconfig.json, src/main.tsx, src/App.tsx, src/index.css, src/test/setup.ts, src/core/smoke.test.ts

**Interfaces:**
- Consumes: 无
- Produces: 可运行工程；npm run test / dev / build 三条命令可用

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "dsh-roleplay",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "dexie": "^4.0.11",
    "dompurify": "^3.2.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^5.0.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/react": "^16.1.0",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: npm install
Expected: 无 error，生成 node_modules 与 package-lock.json

- [ ] **Step 3: 写 vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

- [ ] **Step 4: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 5: 写入口四件套**

index.html：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
    <meta name="theme-color" content="#ffffff" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <title>角色扮演</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

src/index.css：

```css
@import "tailwindcss";

html, body, #root { height: 100%; }
body {
  margin: 0;
  background: #f5f5f7;
  color: #1c1c1e;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  overscroll-behavior-y: none;
}
.safe-bottom { padding-bottom: env(safe-area-inset-bottom); }
```

src/main.tsx：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

src/App.tsx：

```tsx
import PlayScreen from './ui/play/PlayScreen';

export default function App() {
  return <PlayScreen />;
}
```

- [ ] **Step 6: 写测试环境与冒烟测试**

src/test/setup.ts：

```ts
import 'fake-indexeddb/auto';
```

src/core/smoke.test.ts：

```ts
import { describe, it, expect } from 'vitest';

describe('工程骨架', () => {
  it('vitest 能跑起来', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: 运行测试**

Run: npm run test
Expected: PASS，1 passed

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "chore: 搭建 Vite + React + TS + Tailwind v4 + Vitest 工程骨架"
```

---

### Task 2: 存储内核（Dexie schema v1）

**Files:**
- Create: src/core/storage/types.ts, src/core/storage/db.ts
- Test: src/core/storage/db.test.ts

**Interfaces:**
- Consumes: 无
- Produces: DshDB 类、db 单例、newId(prefix?)；类型 CardRecord / CardFileRecord / AssetRecord / ChatRecord / MessageRecord / MemoryRecord / WorldbookRecord / WorldbookEntryRecord / RegexScriptRecord / ProviderRecord / ModelPresetRecord / ConfigRecord / CardUiStateRecord / SettingRecord / ModelParams / ModelCapability / DEFAULT_PARAMS / DEFAULT_CAPABILITY

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DshDB } from './db';

let db: DshDB;
beforeEach(async () => {
  db = new DshDB('test-' + Math.random());
  await db.open();
});

describe('存储内核', () => {
  it('能写入并读回一条消息，且按 chatId 查询', async () => {
    await db.messages.add({
      id: 'm1', chatId: 'c1', parentId: null, role: 'user', raw: '你好',
      status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1,
    });
    const list = await db.messages.where('chatId').equals('c1').toArray();
    expect(list).toHaveLength(1);
    expect(list[0].raw).toBe('你好');
  });

  it('cardFiles 复合主键可读写', async () => {
    await db.cardFiles.put({ cardId: 'card1', path: 'ui/index.html', kind: 'html', text: '<b>hi</b>' });
    const f = await db.cardFiles.get(['card1', 'ui/index.html']);
    expect(f?.text).toBe('<b>hi</b>');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: npm run test -- src/core/storage/db.test.ts
Expected: FAIL，无法解析 ./db

- [ ] **Step 3: 写 types.ts**

```ts
export type CardSource = 'local' | 'imported-st' | 'imported-fy';
export type MessageStatus = 'complete' | 'streaming' | 'incomplete' | 'error';
export type MemoryTier = 'recent' | 'permanent';
export type RegexScope = 'global' | 'chat';
export type RegexTarget = 'display' | 'prompt';
export type ConfigScope = 'global' | 'card' | 'chat';
export type WbPosition = 'before-char' | 'after-char';

export interface CardRecord {
  id: string; name: string; author: string; version: string; description: string;
  tags: string[]; coverAssetId?: string; source: CardSource; spec: string;
  createdAt: number; updatedAt: number;
}
export type CardFileKind = 'json' | 'html' | 'css' | 'template' | 'worldbook' | 'regex' | 'asset';
export interface CardFileRecord { cardId: string; path: string; kind: CardFileKind; text?: string; assetId?: string; }
export interface AssetRecord { id: string; mime: string; size: number; blob: Blob; }
export interface ChatRecord {
  id: string; cardId: string; title: string; vars: Record<string, string>;
  promptSnapshot: string; providerId: string | null; modelPresetId: string | null;
  currentLeafId: string | null; createdAt: number; updatedAt: number; archived: 0 | 1;
}
export interface MessageRecord {
  id: string; chatId: string; parentId: string | null; role: 'user' | 'assistant';
  raw: string; status: MessageStatus; tokensIn: number; tokensOut: number;
  model: string; createdAt: number;
}
export interface MemoryRecord {
  id: string; chatId: string; tier: MemoryTier; text: string; dateLabel: string;
  sourceMessageId: string | null; archivedAt: number | null; order: number;
}
export interface WorldbookRecord { id: string; name: string; description: string; }
export interface WorldbookEntryRecord {
  id: string; worldbookId: string; keys: string[]; secondaryKeys: string[]; content: string;
  constant: boolean; selective: boolean; position: WbPosition; order: number; depth: number;
  recursive: boolean; enabled: boolean;
}
export interface RegexScriptRecord {
  id: string; scope: RegexScope; chatId: string | null; name: string; pattern: string;
  flags: string; replacement: string; enabled: boolean; order: number; target: RegexTarget;
}
export interface ProviderRecord {
  id: string; label: string; protocol: 'openai' | 'anthropic'; baseUrl: string;
  apiKey: string; extraHeaders: Record<string, string>; createdAt: number;
}
export interface ModelCapability {
  temperature: boolean; topP: boolean; presencePenalty: boolean; frequencyPenalty: boolean;
  maxTokens: boolean; contextLength: number; thinkingBudget: boolean; prefill: boolean; systemRole: boolean;
}
export interface ModelParams {
  temperature: number; topP: number; presencePenalty: number; frequencyPenalty: number;
  maxTokens: number; contextLength: number; thinkingBudget: number;
}
export interface ModelPresetRecord {
  id: string; providerId: string; model: string; params: ModelParams; capabilities: ModelCapability;
}
export interface ConfigRecord {
  id: string; scope: ConfigScope; refId: string | null; memoryLimit: number;
  prePrompt: string; postPrompt: string; prompt: string;
}
export interface CardUiStateRecord { cardId: string; key: string; value: string; }
export interface SettingRecord { key: string; value: string; }

export const DEFAULT_PARAMS: ModelParams = {
  temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0,
  maxTokens: 16000, contextLength: 1000000, thinkingBudget: 0,
};

export const DEFAULT_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
  maxTokens: true, contextLength: 1000000, thinkingBudget: false, prefill: false, systemRole: false,
};
```

- [ ] **Step 4: 写 db.ts**

```ts
import Dexie, { type Table } from 'dexie';
import type {
  AssetRecord, CardFileRecord, CardRecord, CardUiStateRecord, ChatRecord, ConfigRecord,
  MemoryRecord, MessageRecord, ModelPresetRecord, ProviderRecord, RegexScriptRecord,
  SettingRecord, WorldbookEntryRecord, WorldbookRecord,
} from './types';

export class DshDB extends Dexie {
  cards!: Table<CardRecord, string>;
  cardFiles!: Table<CardFileRecord, [string, string]>;
  assets!: Table<AssetRecord, string>;
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  memories!: Table<MemoryRecord, string>;
  worldbooks!: Table<WorldbookRecord, string>;
  worldbookEntries!: Table<WorldbookEntryRecord, string>;
  regexScripts!: Table<RegexScriptRecord, string>;
  providers!: Table<ProviderRecord, string>;
  modelPresets!: Table<ModelPresetRecord, string>;
  configs!: Table<ConfigRecord, string>;
  cardUiState!: Table<CardUiStateRecord, [string, string]>;
  settings!: Table<SettingRecord, string>;

  constructor(name = 'dsh-roleplay') {
    super(name);
    this.version(1).stores({
      cards: 'id, updatedAt, name, *tags',
      cardFiles: '[cardId+path], cardId, kind',
      assets: 'id',
      chats: 'id, cardId, updatedAt',
      messages: 'id, chatId, parentId, [chatId+createdAt]',
      memories: 'id, chatId, [chatId+tier]',
      worldbooks: 'id',
      worldbookEntries: 'id, worldbookId, *keys',
      regexScripts: 'id, scope, chatId',
      providers: 'id',
      modelPresets: 'id, providerId',
      configs: 'id, scope, refId',
      cardUiState: '[cardId+key]',
      settings: 'key',
    });
  }
}

export const db = new DshDB();

export function newId(prefix = ''): string {
  return prefix + crypto.randomUUID();
}
```

- [ ] **Step 5: 运行测试**

Run: npm run test -- src/core/storage/db.test.ts
Expected: PASS，2 passed

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(storage): Dexie schema v1 与全量记录类型"
```

---

### Task 3: 装配内核 A —— 条目模型、宏、预算裁剪

**Files:**
- Create: src/core/assembler/types.ts, src/core/assembler/macros.ts, src/core/assembler/budget.ts, src/core/assembler/assemble.ts
- Test: src/core/assembler/assemble.test.ts

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: estimateTokens(text): number；applyMacros(text, ctx): string；assemble(input): AssembledRequest；类型 PromptEntry / EntryPosition / EntrySource / MacroContext / CardPromptParts / ConfigParts / HistoryMessage / MemoryItem / WbEntryInput / Limits / AssembleInput / AssembledRequest

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { assemble } from './assemble';
import { estimateTokens } from './budget';
import { applyMacros } from './macros';
import type { AssembleInput } from './types';

const base: AssembleInput = {
  card: {
    pre: '前置词内容', prompt: '系统提示词', post: '后置词内容',
    description: '角色简介', persona: '主人公设定', scenario: '前情提要',
  },
  config: { prompt: '全局提示词', prePrompt: '全局前置词', postPrompt: '全局后置词' },
  worldbook: [],
  memories: [],
  history: [
    { id: 'h1', role: 'assistant', content: '第一轮' },
    { id: 'h2', role: 'user', content: '第二轮' },
  ],
  userInput: '玩家输入',
  macros: { user: '我', char: '苏小染', persona: '设定', date: '2026-10-13', time: '14:00', weekday: '周二' },
  limits: { contextLength: 100000, maxTokens: 1000, reserve: 512, worldbookTokenBudget: 2000 },
};

describe('装配内核', () => {
  it('顺序：前置词 → 全局提示词 → 卡片提示词 → 设定 → 历史 → 后置词 → 用户输入', () => {
    const r = assemble(base);
    const texts = r.entries.map((e) => e.content);
    expect(texts.indexOf('前置词内容')).toBeLessThan(texts.indexOf('全局提示词'));
    expect(texts.indexOf('全局提示词')).toBeLessThan(texts.indexOf('系统提示词'));
    expect(texts.indexOf('系统提示词')).toBeLessThan(texts.indexOf('角色简介'));
    expect(texts.indexOf('角色简介')).toBeLessThan(texts.indexOf('第一轮'));
    expect(texts.indexOf('第一轮')).toBeLessThan(texts.indexOf('全局后置词'));
    expect(texts.indexOf('全局后置词')).toBeLessThan(texts.indexOf('玩家输入'));
  });

  it('宏替换生效，未定义宏原样保留', () => {
    expect(applyMacros('{{char}} 看着 {{user}}，{{unknown}}', base.macros)).toBe('苏小染 看着 我，{{unknown}}');
  });

  it('预算不足时先裁最老的历史，不裁系统提示词', () => {
    const big = '字'.repeat(4000);
    const r = assemble({
      ...base,
      history: [
        { id: 'h1', role: 'assistant', content: '老' + big },
        { id: 'h2', role: 'user', content: '新' + big },
      ],
      limits: { contextLength: 3000, maxTokens: 100, reserve: 0, worldbookTokenBudget: 100000 },
    });
    const contents = r.entries.map((e) => e.content);
    expect(contents).toContain('系统提示词');
    expect(contents).toContain('玩家输入');
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(contents.find((c) => c.startsWith('老'))).toBeUndefined();
  });
});

describe('token 估算', () => {
  it('汉字按 0.6 估算', () => {
    expect(estimateTokens('你好世界')).toBe(3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: npm run test -- src/core/assembler/assemble.test.ts
Expected: FAIL，找不到 ./assemble

- [ ] **Step 3: 写 types.ts**

```ts
export type EntryPosition = 'pre' | 'system' | 'before-history' | 'history' | 'after-history' | 'post';
export type EntrySource =
  | 'card-pre' | 'card-system' | 'card-post'
  | 'config-prompt' | 'config-pre' | 'config-post'
  | 'worldbook' | 'memory' | 'history' | 'user';

export interface PromptEntry {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  position: EntryPosition;
  priority: number;
  tokens: number;
  source: EntrySource;
  mutable: boolean;
}

export interface MacroContext {
  user: string; char: string; persona: string; date: string; time: string; weekday: string;
}
export interface CardPromptParts {
  pre: string; prompt: string; post: string;
  description: string; persona: string; scenario: string;
}
export interface ConfigParts { prompt: string; prePrompt: string; postPrompt: string; }
export interface HistoryMessage { id: string; role: 'user' | 'assistant'; content: string; }
export interface MemoryItem { id: string; tier: 'recent' | 'permanent'; text: string; dateLabel: string; }
export interface WbEntryInput {
  id: string; keys: string[]; secondaryKeys: string[]; content: string; constant: boolean;
  selective: boolean; position: 'before-char' | 'after-char'; order: number; depth: number;
  recursive: boolean; enabled: boolean;
}
export interface Limits {
  contextLength: number; maxTokens: number; reserve: number; worldbookTokenBudget: number;
}
export interface AssembleInput {
  card: CardPromptParts;
  config: ConfigParts;
  worldbook: WbEntryInput[];
  memories: MemoryItem[];
  history: HistoryMessage[];
  userInput: string;
  macros: MacroContext;
  limits: Limits;
  worldbookMatch?: { caseSensitive?: boolean; wholeWord?: boolean };
}
export interface AssembledRequest {
  entries: PromptEntry[];
  dropped: PromptEntry[];
  totalTokens: number;
  activatedWorldbook: string[];
}
```

- [ ] **Step 4: 写 macros.ts 与 budget.ts**

```ts
import type { MacroContext } from './types';

export function applyMacros(text: string, ctx: MacroContext): string {
  return text.replace(/\{\{\s*(user|char|persona|date|time|weekday)\s*\}\}/g, (m, key: string) => {
    const v = (ctx as unknown as Record<string, string>)[key];
    return v ?? m;
  });
}
```

```ts
const HAN = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/;

export function estimateTokens(text: string): number {
  let han = 0;
  let other = 0;
  for (const ch of text) {
    if (HAN.test(ch)) han += 1;
    else other += 1;
  }
  return Math.ceil(han * 0.6 + other * 0.25);
}
```

- [ ] **Step 5: 写 assemble.ts（世界书先用空数组，Task 4 接入触发）**

```ts
import { estimateTokens } from './budget';
import { applyMacros } from './macros';
import type { AssembledRequest, AssembleInput, PromptEntry } from './types';

const POSITION_RANK: Record<PromptEntry['position'], number> = {
  pre: 0, system: 1, 'before-history': 2, history: 3, 'after-history': 4, post: 5,
};

let seq = 0;

export function assemble(input: AssembleInput): AssembledRequest {
  const { card, config, limits } = input;
  const entries: PromptEntry[] = [];

  const push = (
    source: PromptEntry['source'],
    position: PromptEntry['position'],
    content: string,
    role: PromptEntry['role'] = 'system',
    priority = 0,
    mutable = false,
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    seq += 1;
    entries.push({
      id: 'e' + seq, source, position, content: trimmed, role, priority, mutable,
      tokens: estimateTokens(trimmed),
    });
  };

  push('card-pre', 'pre', applyMacros(card.pre, input.macros));
  push('config-prompt', 'system', applyMacros(config.prompt, input.macros), 'system', 10);
  push('config-pre', 'system', applyMacros(config.prePrompt, input.macros), 'system', 20);
  push('card-system', 'system', applyMacros(card.prompt, input.macros), 'system', 30);
  push('card-system', 'system', applyMacros(card.description, input.macros), 'system', 40);
  push('card-system', 'system', applyMacros(card.persona, input.macros), 'system', 41);
  push('card-system', 'system', applyMacros(card.scenario, input.macros), 'system', 42);

  const wb = input.worldbook;
  for (const w of wb) {
    push('worldbook', 'before-history', applyMacros(w.content, input.macros), 'system',
      w.position === 'after-char' ? 100 + w.order : 50 + w.order, true);
  }

  input.history.forEach((m, i) => {
    push('history', 'history', applyMacros(m.content, input.macros), m.role, i, true);
  });

  const perma = input.memories.filter((m) => m.tier === 'permanent');
  const recent = input.memories.filter((m) => m.tier === 'recent');
  const fmt = (items: typeof perma) => items.map((m) => (m.dateLabel ? '（' + m.dateLabel + '）' : '') + m.text).join('\n');
  if (perma.length) push('memory', 'after-history', '【永久记忆】\n' + fmt(perma), 'system', 10);
  if (recent.length) push('memory', 'after-history', '【近期记忆】\n' + fmt(recent), 'system', 20);

  push('config-post', 'after-history', applyMacros(config.postPrompt, input.macros), 'system', 30);
  push('card-post', 'post', applyMacros(card.post, input.macros));
  push('user', 'post', input.userInput, 'user');

  entries.sort((a, b) =>
    POSITION_RANK[a.position] - POSITION_RANK[b.position] || a.priority - b.priority);

  const budget = limits.contextLength - limits.maxTokens - limits.reserve;
  let total = entries.reduce((s, e) => s + e.tokens, 0);
  const dropped: PromptEntry[] = [];

  if (total > budget) {
    const historyOldestFirst = entries.filter((e) => e.source === 'history').sort((a, b) => a.priority - b.priority);
    const wbLowFirst = entries.filter((e) => e.source === 'worldbook').sort((a, b) => a.priority - b.priority);
    for (const cand of [...historyOldestFirst, ...wbLowFirst]) {
      if (total <= budget) break;
      total -= cand.tokens;
      dropped.push(cand);
    }
  }

  const kept = entries.filter((e) => !dropped.includes(e));
  return {
    entries: kept,
    dropped,
    totalTokens: kept.reduce((s, e) => s + e.tokens, 0),
    activatedWorldbook: wb.map((w) => w.id),
  };
}
```

- [ ] **Step 6: 运行测试**

Run: npm run test -- src/core/assembler/assemble.test.ts
Expected: PASS，4 passed

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(assembler): 条目模型、宏替换、token 预算与装配顺序"
```

---

### Task 4: 装配内核 B —— 世界书触发

**Files:**
- Create: src/core/assembler/worldbook.ts
- Modify: src/core/assembler/assemble.ts（第 5 步的 const wb = input.worldbook; 改为调用 scanWorldbook）
- Test: src/core/assembler/worldbook.test.ts

**Interfaces:**
- Consumes: WbEntryInput（Task 3）
- Produces: scanWorldbook(entries, messages, opts?): WbEntryInput[]；类型 ScanOptions

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { scanWorldbook } from './worldbook';
import type { WbEntryInput } from './types';

const mk = (p: Partial<WbEntryInput> & { id: string; keys: string[]; content: string }): WbEntryInput => ({
  secondaryKeys: [], constant: false, selective: false, position: 'before-char',
  order: 1, depth: 4, recursive: false, enabled: true, ...p,
});

describe('世界书触发', () => {
  it('关键词命中即激活', () => {
    const r = scanWorldbook([mk({ id: 'w1', keys: ['魔法学院'], content: 'A' })], [{ role: 'user', content: '我走进魔法学院' }]);
    expect(r.map((e) => e.id)).toEqual(['w1']);
  });

  it('constant 条目永远激活', () => {
    const r = scanWorldbook([mk({ id: 'w2', keys: ['x'], content: 'A', constant: true })], [{ role: 'user', content: '无关' }]);
    expect(r.map((e) => e.id)).toEqual(['w2']);
  });

  it('selective 需要同时命中次要关键词', () => {
    const e = mk({ id: 'w3', keys: ['学院'], secondaryKeys: ['夜晚'], content: 'A', selective: true });
    expect(scanWorldbook([e], [{ role: 'user', content: '学院' }])).toHaveLength(0);
    expect(scanWorldbook([e], [{ role: 'user', content: '学院 夜晚' }])).toHaveLength(1);
  });

  it('递归扫描最多 3 层且不死循环', () => {
    const a = mk({ id: 'a', keys: ['甲'], content: '这里提到乙', recursive: true });
    const b = mk({ id: 'b', keys: ['乙'], content: '这里提到甲', recursive: true });
    const r = scanWorldbook([a, b], [{ role: 'user', content: '甲' }]);
    expect(r.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('depth 限制扫描的消息条数', () => {
    const e = mk({ id: 'w4', keys: ['隐藏'], content: 'A', depth: 2 });
    const msgs = [
      { role: 'user', content: '隐藏' },
      { role: 'assistant', content: '1' },
      { role: 'user', content: '2' },
    ];
    expect(scanWorldbook([e], msgs)).toHaveLength(0);
  });

  it('未命中的条目不被激活', () => {
    const r = scanWorldbook([mk({ id: 'w5', keys: ['不存在'], content: 'A' })], [{ role: 'user', content: '普通对话' }]);
    expect(r).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: npm run test -- src/core/assembler/worldbook.test.ts
Expected: FAIL，找不到 ./worldbook

- [ ] **Step 3: 写 worldbook.ts**

```ts
import type { WbEntryInput } from './types';

export interface ScanOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxRecursionDepth?: number;
}

const ESCAPE_RE = /[.*+?^$({})|[\]\\]/g;

function hit(text: string, keys: string[], opts: ScanOptions): boolean {
  return keys.some((k) => {
    if (!k) return false;
    if (opts.wholeWord) {
      const pattern = '(^|[^\\p{L}\\p{N}])' + k.replace(ESCAPE_RE, '\\$&') + '([^\\p{L}\\p{N}]|$)';
      return new RegExp(pattern, opts.caseSensitive ? 'u' : 'iu').test(text);
    }
    return opts.caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase());
  });
}

export function scanWorldbook(
  entries: WbEntryInput[],
  messages: { role: string; content: string }[],
  opts: ScanOptions = {},
): WbEntryInput[] {
  const maxDepth = opts.maxRecursionDepth ?? 3;
  const active = new Set<string>();
  const result: WbEntryInput[] = [];

  const activate = (e: WbEntryInput) => {
    if (active.has(e.id)) return;
    active.add(e.id);
    result.push(e);
  };

  for (const e of entries) {
    if (e.enabled && e.constant) activate(e);
  }

  const textFor = (e: WbEntryInput) =>
    messages.slice(-Math.max(1, e.depth)).map((m) => m.content).join('\n');

  const firstLayer: WbEntryInput[] = [];
  for (const e of entries) {
    if (!e.enabled || e.constant) continue;
    const text = textFor(e);
    if (!text) continue;
    const direct = hit(text, e.keys, opts);
    const ok = e.selective ? direct && e.secondaryKeys.length > 0 && hit(text, e.secondaryKeys, opts) : direct;
    if (ok) firstLayer.push(e);
  }
  firstLayer.forEach(activate);

  let frontier = firstLayer.filter((e) => e.recursive);
  for (let layer = 2; layer <= maxDepth && frontier.length > 0; layer += 1) {
    const next: WbEntryInput[] = [];
    for (const src of frontier) {
      for (const e of entries) {
        if (!e.enabled || !e.recursive || active.has(e.id)) continue;
        if (hit(src.content, e.keys, opts)) next.push(e);
      }
    }
    next.forEach(activate);
    frontier = next;
  }

  return result.sort((a, b) => a.order - b.order);
}
```

- [ ] **Step 4: 接入 assemble.ts**

把 assemble.ts 中的

```ts
const wb = input.worldbook;
```

替换为

```ts
const wb = scanWorldbook(
  input.worldbook,
  [...input.history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: input.userInput }],
  input.worldbookMatch,
);
```

并在文件顶部加：

```ts
import { scanWorldbook } from './worldbook';
```

- [ ] **Step 5: 运行装配全部测试**

Run: npm run test -- src/core/assembler
Expected: PASS，10 passed

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(assembler): 世界书关键词触发、常驻、递归与扫描深度"
```


### Task 5: 渲染内核 A —— 思维链、记忆、选项提取

**Files:**
- Create: src/core/render/extract.ts
- Test: src/core/render/extract.test.ts

**Interfaces:**
- Consumes: 无（纯函数，用 DOMParser）
- Produces: extractThink(raw): { think: string[]; body: string }；extractMemories(html): { body: string; memories: ExtractedMemory[] }；extractOptions(html): { body: string; options: ExtractedOption[] }；extractAll(raw): ExtractResult；类型 ExtractedMemory / ExtractedOption / ExtractResult

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { extractAll, extractOptions, extractThink } from './extract';

const SAMPLE = [
  '<!-- 医疗研究-数据流 -->',
  '<!--<think>这里不该出现</think>-->',
  '<details><summary>📅状况</summary>🌍世界：现代都市<br>⏰时间：傍晚</details>',
  '<plot>她站在洗手台前，看着镜子里的自己。</plot>',
  '<details><summary>近期记忆</summary>',
  '当前记忆数目：1/4',
  '[1]（2026-10-13 午后）苏小染拆穿了偷窥者。',
  '</details>',
  '<hr class="separator">',
  '<p>👉选项：</p>',
  '<p>A. 继续调侃他</p>',
  '<p>B. 转身离开</p>',
  '<p>C. 威胁告诉校长</p>',
].join('\n');

describe('渲染内核 · 提取', () => {
  it('思维链与 HTML 注释被剥离', () => {
    const r = extractThink(SAMPLE);
    expect(r.think.join('')).toContain('这里不该出现');
    expect(r.body).not.toContain('think');
    expect(r.body).not.toContain('医疗研究-数据流');
  });

  it('提取 A–F 选项并保留正文', () => {
    const r = extractOptions(SAMPLE);
    expect(r.options.map((o) => o.key)).toEqual(['A', 'B', 'C']);
    expect(r.options[0].text).toBe('继续调侃他');
    expect(r.body).toContain('她站在洗手台前');
    expect(r.body).not.toContain('A. 继续调侃他');
  });

  it('extractAll 同时拿到记忆与选项', () => {
    const r = extractAll(SAMPLE);
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0].tier).toBe('recent');
    expect(r.memories[0].dateLabel).toContain('2026-10-13');
    expect(r.memories[0].text).toContain('拆穿了偷窥者');
    expect(r.options).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: npm run test -- src/core/render/extract.test.ts
Expected: FAIL，找不到 ./extract

- [ ] **Step 3: 写 extract.ts**

```ts
export interface ExtractedMemory { tier: 'recent' | 'permanent'; text: string; dateLabel: string; }
export interface ExtractedOption { key: string; text: string; }
export interface ExtractResult {
  think: string[];
  body: string;
  memories: ExtractedMemory[];
  options: ExtractedOption[];
}

const OPTION_RE = /^\s*([A-F])\s*[.、．:：]\s*(.+)$/;
const MEMORY_ENTRY_RE = /\[(\d+)\]\s*[（(]?([^）)]*)[）)]?\s*([\s\S]*?)(?=\[\d+\]|$)/g;

export function extractThink(raw: string): { think: string[]; body: string } {
  const think: string[] = [];
  const body = raw.replace(/<!--([\s\S]*?)-->/g, (_m, inner: string) => {
    const text = inner.replace(/<\/?think>/g, '').trim();
    if (text) think.push(text);
    return '';
  });
  return { think, body };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString('<div id="root">' + html + '</div>', 'text/html');
}

export function extractOptions(html: string): { body: string; options: ExtractedOption[] } {
  const doc = parse(html);
  const root = doc.getElementById('root')!;
  const paragraphs = Array.from(root.querySelectorAll('p'));
  const matched: { el: Element; key: string; text: string }[] = [];
  for (const p of paragraphs) {
    const m = OPTION_RE.exec(p.textContent ?? '');
    if (m) matched.push({ el: p, key: m[1], text: m[2].trim() });
  }
  let options: ExtractedOption[] = [];
  if (matched.length >= 2 && matched[0].key === 'A') {
    const consecutive: typeof matched = [];
    const expected = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    for (const item of matched) {
      if (item.key === expected[consecutive.length]) consecutive.push(item);
      else break;
    }
    options = consecutive.map((c) => ({ key: c.key, text: c.text }));
    const last = consecutive[consecutive.length - 1].el;
    let node: Element | null = consecutive[0].el;
    while (node) {
      const next: Element | null = node.nextElementSibling;
      node.remove();
      if (node === last) break;
      node = next;
    }
    const hr = root.querySelector('hr.separator');
    if (hr) hr.remove();
    const intro = Array.from(root.querySelectorAll('p')).find((p) => (p.textContent ?? '').includes('选项'));
    if (intro) intro.remove();
  }
  return { body: root.innerHTML, options };
}

export function extractMemories(html: string): { body: string; memories: ExtractedMemory[] } {
  const doc = parse(html);
  const root = doc.getElementById('root')!;
  const memories: ExtractedMemory[] = [];
  for (const details of Array.from(root.querySelectorAll('details'))) {
    const summary = details.querySelector('summary')?.textContent ?? '';
    const tier = summary.includes('永久记忆') ? 'permanent' : summary.includes('近期记忆') ? 'recent' : null;
    if (!tier) continue;
    const text = details.textContent ?? '';
    MEMORY_ENTRY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = MEMORY_ENTRY_RE.exec(text)) !== null) {
      const entryText = (m[3] ?? '').trim();
      if (!entryText) continue;
      found = true;
      memories.push({ tier, dateLabel: (m[2] ?? '').trim(), text: entryText });
    }
    if (found) details.remove();
  }
  return { body: root.innerHTML, memories };
}

export function extractAll(raw: string): ExtractResult {
  const t = extractThink(raw);
  const m = extractMemories(t.body);
  const o = extractOptions(m.body);
  return { think: t.think, body: o.body, memories: m.memories, options: o.options };
}
```

- [ ] **Step 4: 运行测试**

Run: npm run test -- src/core/render/extract.test.ts
Expected: PASS，3 passed

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(render): 思维链剥离、记忆与 A-F 选项提取"
```

---

### Task 6: 渲染内核 B —— 白名单清洗与管线

**Files:**
- Create: src/core/render/sanitize.ts, src/core/render/pipeline.ts
- Test: src/core/render/sanitize.test.ts, src/core/render/pipeline.test.ts

**Interfaces:**
- Consumes: extract.ts（Task 5）
- Produces: sanitizeHtml(html): string；renderMessage(raw, opts?): { blocks: RenderBlock[]; think: string; memories: ExtractedMemory[] }；类型 RenderBlock

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('渲染内核 · 清洗', () => {
  it('脚本与事件处理器被清除', () => {
    const out = sanitizeHtml('<p onclick="alert(1)">hi</p><script>alert(2)</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });

  it('iframe 与 javascript: 协议被清除', () => {
    const out = sanitizeHtml('<iframe src="https://evil.com"></iframe><a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('javascript:');
  });

  it('安全的行内样式保留，危险样式剔除', () => {
    const out = sanitizeHtml('<span style="color: #0072E3; font-weight: bold; position: fixed; z-index: 9999">蓝</span>');
    expect(out).toContain('color');
    expect(out).not.toContain('position');
    expect(out).not.toContain('9999');
  });

  it('details / summary / plot 等叙事标签保留', () => {
    const out = sanitizeHtml('<details><summary>状态</summary><plot>正文</plot></details>');
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>');
    expect(out).toContain('<plot>');
  });
});
```

- [ ] **Step 2: 写 pipeline 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { renderMessage } from './pipeline';

const RAW = [
  '<details><summary>📅状况</summary>世界：现代都市</details>',
  '<plot>正文段落</plot>',
  '<p>A. 选项一</p>',
  '<p>B. 选项二</p>',
].join('\n');

describe('渲染内核 · 管线', () => {
  it('折叠块 / 正文块 / 选项块被分别识别', () => {
    const r = renderMessage(RAW);
    const kinds = r.blocks.map((b) => b.kind);
    expect(kinds).toContain('collapse');
    expect(kinds).toContain('plot');
    expect(kinds).toContain('options');
    const opts = r.blocks.find((b) => b.kind === 'options');
    expect(opts && opts.kind === 'options' ? opts.items.length : 0).toBe(2);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: npm run test -- src/core/render
Expected: FAIL，找不到 ./sanitize 与 ./pipeline

- [ ] - [ ] - [ ] **Step 4: 写 sanitize.ts**

```ts
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'details', 'summary', 'plot', 'p', 'br', 'hr', 'span', 'div', 'b', 'i', 'em', 'strong',
  'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead',
  'tbody', 'tr', 'td', 'th', 'blockquote', 'code', 'pre', 'img', 'ruby', 'rt', 'small',
  'sub', 'sup', 'mark', 'del', 'ins',
];

const ALLOWED_ATTR = ['class', 'style', 'src', 'alt', 'colspan', 'rowspan', 'data-card'];

const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family',
  'text-align', 'text-decoration', 'text-shadow', 'line-height', 'letter-spacing',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-style', 'border-width', 'border-radius', 'opacity',
  'width', 'height', 'max-width', 'display', 'gap', 'flex', 'flex-direction', 'align-items',
]);

const DANGEROUS_VALUE = /(url\s*\(|expression\s*\(|javascript:|position\s*:\s*fixed|z-index)/i;

let installed = false;
function installHook() {
  if (installed) return;
  installed = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'style') return;
    const kept = (data.attrValue || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((decl) => {
        const idx = decl.indexOf(':');
        if (idx < 0) return false;
        const prop = decl.slice(0, idx).trim().toLowerCase();
        const value = decl.slice(idx + 1).trim();
        if (!SAFE_STYLE_PROPS.has(prop)) return false;
        if (prop === 'display' && !/^(block|inline|inline-block|flex|grid|none)$/.test(value)) return false;
        return !DANGEROUS_VALUE.test(decl);
      });
    if (kept.length === 0) data.keepAttr = false;
    else data.attrValue = kept.join('; ');
  });
}

export function sanitizeHtml(html: string): string {
  installHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcdoc'],
  });
}
```

- [ ] **Step 5: 写 pipeline.ts**

```ts
import { extractAll, type ExtractedMemory } from './extract';
import { sanitizeHtml } from './sanitize';

export type RenderBlock =
  | { kind: 'collapse'; summary: string; html: string }
  | { kind: 'plot'; html: string }
  | { kind: 'options'; items: { key: string; text: string }[] }
  | { kind: 'html'; html: string };

export interface RenderResult {
  blocks: RenderBlock[];
  think: string;
  memories: ExtractedMemory[];
}

export function renderMessage(raw: string): RenderResult {
  const { think, body, memories, options } = extractAll(raw);
  const safe = sanitizeHtml(body);
  const doc = new DOMParser().parseFromString('<div id="root">' + safe + '</div>', 'text/html');
  const root = doc.getElementById('root')!;
  const blocks: RenderBlock[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.join('').trim()) blocks.push({ kind: 'html', html: buffer.join('') });
    buffer = [];
  };

  for (const child of Array.from(root.children)) {
    if (child.tagName === 'DETAILS') {
      flush();
      const summary = child.querySelector('summary')?.textContent?.trim() ?? '';
      const clone = child.cloneNode(true) as Element;
      clone.querySelector('summary')?.remove();
      blocks.push({ kind: 'collapse', summary, html: clone.innerHTML });
    } else if (child.tagName === 'PLOT') {
      flush();
      blocks.push({ kind: 'plot', html: child.innerHTML });
    } else {
      buffer.push(child.outerHTML);
    }
  }
  flush();

  if (options.length > 0) blocks.push({ kind: 'options', items: options });
  return { blocks, think: think.join('\n'), memories };
}
```

- [ ] **Step 6: 运行测试**

Run: npm run test -- src/core/render
Expected: PASS，5 passed

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(render): 白名单清洗与折叠/正文/选项渲染管线"
```

---

### Task 7: 适配内核 —— 类型、SSE、mock、OpenAI 兼容

**Files:**
- Create: src/core/providers/types.ts, src/core/providers/sse.ts, src/core/providers/mock.ts, src/core/providers/openai.ts
- Test: src/core/providers/sse.test.ts, src/core/providers/openai.test.ts, src/core/providers/mock.test.ts

**Interfaces:**
- Consumes: storage/types.ts 的 ModelParams / ModelCapability
- Produces: parseSSE(stream): AsyncGenerator<{ event?: string; data: string }>；buildOpenAIBody(cfg, req)：纯函数；streamOpenAI(cfg, req): AsyncGenerator<StreamEvent>；createMockAdapter(script): ProviderAdapter；类型 ChatMessage / ChatRequest / StreamEvent / ProviderConfig / ProviderAdapter

- [ ] **Step 1: 写 SSE 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { parseSSE } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

describe('SSE 解析', () => {
  it('跨分片拼接 data 行', async () => {
    const stream = streamOf(['data: {"a"', ':1}\n\n', 'data: [DONE]\n\n']);
    const out: string[] = [];
    for await (const ev of parseSSE(stream)) out.push(ev.data);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });

  it('忽略注释行与空行', async () => {
    const stream = streamOf([': ping\n\n', 'data: x\n\n']);
    const out: string[] = [];
    for await (const ev of parseSSE(stream)) out.push(ev.data);
    expect(out).toEqual(['x']);
  });
});
```

- [ ] **Step 2: 写 mock 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { createMockAdapter } from './mock';

describe('mock 适配器', () => {
  it('把脚本按片流式吐出并给出 done', async () => {
    const adapter = createMockAdapter('你好世界', { chunkSize: 2, delayMs: 0 });
    const cfg = { id: 'm', baseUrl: '', apiKey: '', extraHeaders: {} };
    let text = '';
    let done = false;
    for await (const ev of adapter.streamChat(cfg, {
      model: 'mock', messages: [], params: { temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0, maxTokens: 100, contextLength: 1000, thinkingBudget: 0 },
      capabilities: { temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true, maxTokens: true, contextLength: 1000, thinkingBudget: false, prefill: false, systemRole: false },
    })) {
      if (ev.type === 'text') text += ev.delta;
      if (ev.type === 'done') done = true;
    }
    expect(text).toBe('你好世界');
    expect(done).toBe(true);
  });
});
```

- [ ] **Step 3: 写 OpenAI 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildOpenAIBody } from './openai';

const cfg = { id: 'p', baseUrl: 'https://api.example.com', apiKey: 'sk-x', extraHeaders: {} };
const base = {
  model: 'deepseek-chat',
  messages: [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }],
  params: { temperature: 0.8, topP: 0.9, presencePenalty: 0.1, frequencyPenalty: 0.2, maxTokens: 2048, contextLength: 64000, thinkingBudget: 0 },
};

describe('OpenAI 兼容适配器', () => {
  it('能力全开时发送全部参数', () => {
    const body = buildOpenAIBody(cfg, {
      ...base,
      capabilities: { temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true, maxTokens: true, contextLength: 64000, thinkingBudget: false, prefill: false, systemRole: false },
    });
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.8);
    expect(body.max_tokens).toBe(2048);
    expect(body.presence_penalty).toBe(0.1);
  });

  it('模型不支持某参数时不发送该字段', () => {
    const body = buildOpenAIBody(cfg, {
      ...base,
      capabilities: { temperature: true, topP: false, presencePenalty: false, frequencyPenalty: false, maxTokens: false, contextLength: 64000, thinkingBudget: false, prefill: false, systemRole: false },
    });
    expect(body.temperature).toBe(0.8);
    expect('top_p' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect('presence_penalty' in body).toBe(false);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: npm run test -- src/core/providers
Expected: FAIL，找不到模块

- [ ] **Step 5: 写 types.ts**

```ts
import type { ModelCapability, ModelParams } from '../storage/types';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ProviderConfig {
  id: string; baseUrl: string; apiKey: string; extraHeaders: Record<string, string>;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  params: ModelParams;
  capabilities: ModelCapability;
}
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string; status?: number };
export interface ProviderAdapter {
  id: 'openai' | 'anthropic' | 'mock';
  listModels(cfg: ProviderConfig): Promise<string[]>;
  streamChat(cfg: ProviderConfig, req: ChatRequest): AsyncGenerator<StreamEvent>;
}
export const MOCK_CAPABILITY: ModelCapability = {
  temperature: true, topP: true, presencePenalty: true, frequencyPenalty: true,
  maxTokens: true, contextLength: 1000000, thinkingBudget: false, prefill: false, systemRole: false,
};
```

- [ ] **Step 6: 写 sse.ts**

```ts
export interface SseEvent { event?: string; data: string; }

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const ev = parseLine(line);
        if (ev) yield ev;
        idx = buffer.indexOf('\n');
      }
    }
    const tail = parseLine(buffer.replace(/\r$/, ''));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): SseEvent | null {
  if (!line || line.startsWith(':')) return null;
  if (line.startsWith('data:')) return { data: line.slice(5).trimStart() };
  if (line.startsWith('event:')) return { event: line.slice(6).trim(), data: '' };
  return null;
}
```

- [ ] **Step 7: 写 mock.ts**

```ts
import type { ChatRequest, ProviderAdapter, ProviderConfig, StreamEvent } from './types';

export interface MockOptions { chunkSize?: number; delayMs?: number; }

export function createMockAdapter(script: string, opts: MockOptions = {}): ProviderAdapter {
  const chunkSize = opts.chunkSize ?? 12;
  const delayMs = opts.delayMs ?? 30;
  return {
    id: 'mock',
    async listModels() {
      return ['mock-model'];
    },
    async *streamChat(_cfg: ProviderConfig, _req: ChatRequest): AsyncGenerator<StreamEvent> {
      yield { type: 'reasoning', delta: '（mock 思考：按卡片格式生成状态栏与选项）' };
      for (let i = 0; i < script.length; i += chunkSize) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        yield { type: 'text', delta: script.slice(i, i + chunkSize) };
      }
      yield { type: 'usage', inputTokens: 800, outputTokens: Math.ceil(script.length / 2) };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

export function mockReplyFor(userInput: string, cardName: string): string {
  const option = userInput.trim().slice(0, 12) || '继续';
  return [
    '<details><summary>📅状况</summary>🌍世界：现代都市日常<br>',
    '⏰时间：2026年10月13日 星期二 傍晚<br>',
    '🏘️地点：教学楼三楼走廊<br>',
    '❤️性癖：萝莉，C罩杯，圆盘型胸部，白虎/无毛<br>',
---

## 执行状态（2026-10-13 收尾）

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 骨架 + 可玩闭环 | 完成 | 任务 1-10 全部落地，测试覆盖 |
| M1 卡片包与编辑器 | 完成 | zip 读写、酒馆 PNG 卡互转、列表、编辑器（提示词/世界书/正则/界面） |
| M2 模型接入 | 完成 | OpenAI 兼容 + Anthropic 适配器、能力矩阵参数面板、测试连接、全局配置 |
| M3 卡片 HTML 界面 | 完成 | 沙箱宿主 + 桥脚本 + 声明式字段 + 模板引擎 + 预览 + 一键开局 |
| M4 记忆/正则/备份 | 完成 | 记忆托管与归档回注、正则两层作用域、全量备份导出导入 |
| M5 打磨 | 部分 | 消息操作、会话列表、记忆面板、阅读字号已完成；虚拟滚动与 Service Worker 未做 |

**验证证据**

- 测试：25 个测试文件 / 82 个用例全部通过
- 构建：tsc 无类型错误，产物约 379 kB（gzip 127 kB）
- 运行：npm run dev 可访问，卡片列表 → 交互界面 → 生成提示词 → 开局全链路可用

**与计划的偏差**

- Task 3 的分支测试断言原写法有误（branchTo 到叶节点不产生分叉），已改为 branchTo 到用户消息并断言「库里 5 条、当前世界线 4 条」。
- Anthropic 载荷映射：后置词并入最后一条 user 消息之前（原计划未细化物理映射），并补了对应测试。
- vitest 从 2 升到 3，解决其自带 Vite 5 与项目 Vite 6 的类型冲突。
- Playwright E2E 未做，改由 RTL 组件/集成测试覆盖同样路径（含一键开局、记忆回注、分支删除）。
