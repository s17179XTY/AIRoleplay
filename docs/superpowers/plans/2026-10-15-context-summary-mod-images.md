# 上下文窗口 / 摘要记忆库 / MOD / 图片 / 同步冲突 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「上下文窗口 + 摘要记忆库」换成新的语义，并一次做完 MOD、图片、同步冲突与 12 项快速修。

**Architecture:** 上下文不再「全塞」，而是按用户选的窗口（最近 N 条 / 全部）裁剪；掉出窗口的「交换」交给模型压成摘要存进 `memories` 表（改成摘要库）；装配层新增 MOD 与摘要两个注入源；聊天页加 HUD 显示占用。图片走已有的 `assets` + 加密 blob 通道，只加校验与 UI。

**Tech Stack:** React 18 + Vite 6 + Tailwind 4 + Zustand + Dexie 4 + TypeScript strict + vitest(jsdom)；后端 Cloudflare Worker + D1 + KV。

**Spec:** `docs/superpowers/specs/2026-10-15-context-summary-mod-images-design.md`

## Global Constraints

- `src/core/` 与 `src/core/sync/` **不得 import React**；`src/ui/` 不得出现提示词拼接与 HTML 解析。
- `messages.raw` 一旦落库永不修改；正则 / 渲染规则改动只影响展示层。
- 加密参数（PBKDF2 迭代数等）一律由调用端传入，不许读模块层常量。
- `providers.apiKey` 与 `providers.extraHeaders` 永不上云。
- 服务器零知识：`worker/` 不得出现解密代码。
- 手机端 UI：外壳铺满；唯一的 `max-width: 430px` 只能出现在 `@media (min-width: 480px)` 里。
- 字号统一走 CSS 变量 `--dsh-fs`，内部用 `em`。
- 每个任务结束都要 `npm run test` 全绿 + `npm run build` 无错；中文 commit，`fix:` / `feat:` / `chore:` 前缀。
- Windows：`npm run worker:*` 会因 `.cmd` shim 报 `Unknown arguments`；要跑 wrangler 就直接呼叫 `wrangler ...`，脚本用 `node.exe`。
- 旧的 `memories` 条目**逐条 `delete(id)`** 清（产生墓碑），**禁止用 `clear()`**。

---

## 文件结构（先定边界，再拆任务）

| 文件 | 责任 |
|---|---|
| `src/core/assembler/window.ts`（新） | 只做一件事：给一串消息与窗口设定，算出「窗口内 / 窗口外」，并把边界对齐到完整交换 |
| `src/core/assembler/summarize.ts`（新） | 压缩提示词、调模型、解析「用户/叙事」两段、失败计数与骨架兜底。**不碰数据库**，纯函数 + 一次请求 |
| `src/core/assembler/assemble.ts`（改） | 注入来源：MOD(system 35)、摘要(before-history 200+)、窗口内历史（不剥记忆块）、移除简介注入 |
| `src/core/storage/memoryStore.ts`（改） | 摘要的增删查 + 20 条上限与合并；删掉旧的近期/永久归档逻辑 |
| `src/core/storage/migrate.ts`（新） | 一次性迁移：清旧记忆条目（逐条删）+ 写 `memorySchema` 标记 |
| `src/core/storage/modRepo.ts`（新） | MOD 表的 CRUD |
| `src/core/storage/image.ts`（新） | 图片校验（magic byte / 体积 / 尺寸）与压缩 |
| `src/state/useSession.ts`（改） | `summarizing` 状态、发送前先压缩、锁发送、`previewContext()` 接缝 |
| `src/ui/play/ContextHud.tsx`（新） | 顶栏那一行 + 明细弹层 |
| `src/ui/play/ScrollButtons.tsx`（新） | 右下角「回到顶部 / 回到底部」图标按钮 |
| `src/ui/settings/ModSection.tsx`（新） | MOD 设置分节 |
| `src/ui/settings/ConflictPanel.tsx`（新） | 冲突查看与还原 |
| `src/ui/cards/ImageSlots.tsx`（新） | 封面 / 头像上传槽（含账号门槛提示） |

---

## 阶段 1：数据与装配（不可分割的核心）

### Task 1: 类型与设置键

**Files:**
- Modify: `src/core/storage/types.ts`
- Modify: `src/core/assembler/types.ts`
- Test: `src/core/storage/types.test.ts`（新建）

**Interfaces:**
- Produces:
  - `MemoryRecord` 新增可选字段 `userText?: string`、`assistantText?: string`、`fromMessageId?: string`、`toMessageId?: string`、`messageCount?: number`、`origin?: MemoryOrigin`、`tokenCount?: number`、`createdAt?: number`；`MemoryTier` 增加 `'summary'`。
  - `type MemoryOrigin = 'model' | 'merged' | 'local-skeleton'`
  - `ModRecord { id, name, content, enabled, order, createdAt, updatedAt }`
  - `CardRecord.avatarAssetId?: string`
  - `SummaryItem { id, text, userText?, assistantText?, dateLabel, rangeLabel? }`
  - `ModItem { id, name, content, order }`
  - `ContextMode = 'recent' | 'all'`
  - 常量 `SETTING_CONTEXT_MODE='contextMode'`、`SETTING_CONTEXT_LIMIT='contextMessageLimit'`、`SETTING_SUMMARY_ENABLED='summaryEnabled'`、`SETTING_SUMMARY_BATCH='summaryBatchPairs'`、`SETTING_MEMORY_SCHEMA='memorySchema'`、`MEMORY_SCHEMA_VERSION='summary-v1'`、`DEFAULT_CONTEXT_MODE: ContextMode='recent'`、`DEFAULT_CONTEXT_LIMIT=6`、`DEFAULT_SUMMARY_BATCH=1`、`SUMMARY_MAX_CHARS=200`、`SUMMARY_KEEP=20`、`SUMMARY_MERGE_BATCH=5`

- [ ] **Step 1: 写失败测试**（断言常量存在、`MemoryRecord` 可带 `origin: 'model'`、`ModRecord` 字段齐全）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 改 `types.ts` 与 `src/core/assembler/types.ts`**：`AssembleInput` 把 `memories: MemoryItem[]` 换成 `summaries?: SummaryItem[]`，新增 `mods?: ModItem[]`；`EntrySource` 增加 `'mod'`；删掉 `MemoryItem` 或保留为 deprecated（`MemoryItem` 仍被 `memoryStore.toMemoryItems` 引用，本任务一并删掉该函数的调用点会在 Task 7 处理 —— 本任务先把 `MemoryItem` 标 `@deprecated` 保留，避免一次改太多）。
- [ ] **Step 4: 跑测试确认通过；`npm run build` 必须无错**（注意：换掉 `AssembleInput.memories` 会让 `useSession.ts` 编译失败——本任务先同时把 `useSession` 的调用改成 `summaries: toSummaryItems(memoryRecords)` 的**最小改动**，`toSummaryItems` 暂时用旧字段拼，Task 7 再换成真摘要）
- [ ] **Step 5: commit** `feat: 摘要库与 MOD 的数据类型（阶段1/Task1）`

---

### Task 2: 窗口与成对规则

**Files:**
- Create: `src/core/assembler/window.ts`
- Test: `src/core/assembler/window.test.ts`

**Interfaces:**
- Produces:
  - `interface WindowMessage { id: string; role: 'user' | 'assistant' }`
  - `interface Exchange { ids: string[]; complete: boolean }`
  - `function buildExchanges(messages: WindowMessage[]): Exchange[]`
  - `function computeWindow(input: { messages: WindowMessage[]; mode: 'recent' | 'all'; limit: number; keptIds?: Set<string> }): { windowIds: string[]; outsideIds: string[] }`

- [ ] **Step 1: 写失败测试**（真实代码，照抄）

```ts
import { describe, it, expect } from 'vitest';
import { buildExchanges, computeWindow } from './window';

const M = (id: string, role: 'user' | 'assistant') => ({ id, role });

describe('window', () => {
  it('user + 紧跟的 assistant 是一个交换', () => {
    expect(buildExchanges([M('u1', 'user'), M('a1', 'assistant')]))
      .toEqual([{ ids: ['u1', 'a1'], complete: true }]);
  });

  it('开场白（没有对应用户输入）自成完整单位', () => {
    expect(buildExchanges([M('a0', 'assistant'), M('u1', 'user'), M('a1', 'assistant')]))
      .toEqual([{ ids: ['a0'], complete: true }, { ids: ['u1', 'a1'], complete: true }]);
  });

  it('未完成的交换（用户发了但 AI 没回）标记 incomplete', () => {
    expect(buildExchanges([M('u1', 'user'), M('u2', 'user')]))
      .toEqual([{ ids: ['u1', 'u2'], complete: false }]);
  });

  it('recent 模式：从后面取到累计条数 >= limit，绝不切开一个交换', () => {
    // 6 条消息、limit=4 → 从后面取 u2,a2 只有 2 条，再取 u1,a1 共 4 条 → window = 后 4 条
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 4 });
    expect(r.windowIds).toEqual(['u1', 'a1', 'u2', 'a2']);

    // limit=3 时不能只取 a2 → 必须连 u2 一起（交换完整优先，窗口会到 4 条）
    const r3 = computeWindow({ messages: msgs, mode: 'recent', limit: 3 });
    expect(r3.windowIds).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('recent 模式：切点落在交换中间时把整对都算窗口外', () => {
    const msgs = [
      M('u1', 'user'), M('a1', 'assistant'),
      M('u2', 'user'), M('a2', 'assistant'),
      M('u3', 'user'), M('a3', 'assistant'),
    ];
    // limit=5 → 从后面取 a2,a3 会切开 (u2,a2) → 整对算窗口外 → window = u3,a3 ... 还要补到 >=5？
    // 规则：以「完整交换」为单位从后往前累加，累到 >= limit 就停 → 取 u2,a2 + u3,a3 = 4 条 < 5 → 再取 u1,a1 = 6 条
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 5 });
    expect(r.windowIds).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
    expect(r.outsideIds).toEqual([]);
  });

  it('recent 模式：窗口外的部分按顺序回传', () => {
    const msgs = [];
    for (let i = 1; i <= 10; i += 1) { msgs.push(M(`u${i}`, 'user'), M(`a${i}`, 'assistant')); }
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 4 });
    expect(r.windowIds).toEqual(['u9', 'a9', 'u10', 'a10']);
    expect(r.outsideIds).toHaveLength(16);
    expect(r.outsideIds[0]).toBe('u1');
  });

  it('未完成的尾部交换不会被挤出窗口（留在窗口内，不压半对）', () => {
    const msgs = [
      M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant'),
      M('u3', 'user'), M('a3', 'assistant'), M('u4', 'user'),
    ];
    const r = computeWindow({ messages: msgs, mode: 'recent', limit: 4 });
    // 尾部未完成的 {u4} 必须在窗口内
    expect(r.windowIds).toContain('u4');
  });

  it('all 模式：用 assemble 保留的 id 判定窗口内外，并把边界对齐到交换', () => {
    const msgs = [M('u1', 'user'), M('a1', 'assistant'), M('u2', 'user'), M('a2', 'assistant')];
    // 只保留了 a2（切开了 u2,a2）→ 整对都算窗口外
    const r = computeWindow({ messages: msgs, mode: 'all', limit: 0, keptIds: new Set(['a2']) });
    expect(r.windowIds).toEqual([]);
    expect(r.outsideIds).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npm run test -- src/core/assembler/window.test.ts`
- [ ] **Step 3: 实现**

```ts
export interface WindowMessage { id: string; role: 'user' | 'assistant' }
export interface Exchange { ids: string[]; complete: boolean }

/** 把消息切成「交换」单位：user + 紧跟的 assistant；开场白自成完整单位；未完成的尾部合成一个 incomplete 单位 */
export function buildExchanges(messages: WindowMessage[]): Exchange[] {
  const out: Exchange[] = [];
  let open: Exchange | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (open) open.ids.push(m.id);          // 连续用户消息：併进同一个未完成交换
      else { open = { ids: [m.id], complete: false }; out.push(open); }
      continue;
    }
    if (open) { open.ids.push(m.id); open.complete = true; open = null; continue; }
    out.push({ ids: [m.id], complete: true }); // 开场白
  }
  return out;
}

export function computeWindow(input: {
  messages: WindowMessage[];
  mode: 'recent' | 'all';
  limit: number;
  keptIds?: Set<string>;
}): { windowIds: string[]; outsideIds: string[] } {
  const { messages, mode, limit, keptIds } = input;
  if (messages.length === 0) return { windowIds: [], outsideIds: [] };
  const exchanges = buildExchanges(messages);

  // 從後面往前累加完整交換，直到條數 >= limit（recent）
  // all 模式則看這個交換「是否有任何一條被 assemble 保留」
  let cut = exchanges.length;
  if (mode === 'recent') {
    let count = 0;
    for (let i = exchanges.length - 1; i >= 0; i -= 1) {
      if (count >= limit) break;
      count += exchanges[i].ids.length;
      cut = i;
    }
  } else {
    for (let i = 0; i < exchanges.length; i += 1) {
      const anyKept = exchanges[i].ids.some((id) => keptIds?.has(id));
      if (anyKept) { cut = i; break; }
      cut = i + 1;
    }
  }

  const windowIds: string[] = [];
  const outsideIds: string[] = [];
  exchanges.forEach((ex, i) => {
    if (i < cut) outsideIds.push(...ex.ids);
    else windowIds.push(...ex.ids);
  });
  return { windowIds, outsideIds };
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 上下文窗口与成对规则（阶段1/Task2）`

---

### Task 3: 迁移：清掉旧记忆条目

**Files:**
- Create: `src/core/storage/migrate.ts`
- Test: `src/core/storage/migrate.test.ts`

**Interfaces:**
- Consumes: `SETTING_MEMORY_SCHEMA`、`MEMORY_SCHEMA_VERSION`（Task 1）
- Produces: `async function migrateMemorySchema(db: DshDB = liveDb): Promise<{ deleted: number; ran: boolean }>`

- [ ] **Step 1: 写失败测试**（关键断言：**逐条删会产生墓碑，而不是 deleteRange**）

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { migrateMemorySchema } from './migrate';
import { installSyncTap } from '../sync/outbox';
import { SETTING_MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from './types';

beforeEach(async () => {
  await db.memories.clear();
  await db.settings.clear();
  await db.syncOutbox.clear();
  await installSyncTap(db);
});

const oldRow = (id: string) => ({
  id, chatId: 'c1', tier: 'recent' as const, text: '旧的', dateLabel: '10-01',
  sourceMessageId: null, archivedAt: null, order: 1,
});

describe('记忆库迁移', () => {
  it('旧的 recent/permanent 条目被逐条删除，并且产生墓碑（云端才会一起清）', async () => {
    await db.memories.put(oldRow('m1'));
    await db.memories.put({ ...oldRow('m2'), tier: 'permanent' });
    const r = await migrateMemorySchema(db);
    expect(r.ran).toBe(true);
    expect(r.deleted).toBe(2);
    expect(await db.memories.count()).toBe(0);
    const tombstones = await db.syncOutbox.toArray();
    expect(tombstones.filter((t) => t.kind === 'memory' && t.deleted === 1)).toHaveLength(2);
  });

  it('已经迁移过就不再跑（标记只写一次）', async () => {
    await db.memories.put(oldRow('m1'));
    await migrateMemorySchema(db);
    await db.memories.put(oldRow('m3'));
    const again = await migrateMemorySchema(db);
    expect(again.ran).toBe(false);
    expect(await db.memories.get('m3')).toBeTruthy();
    expect((await db.settings.get(SETTING_MEMORY_SCHEMA))?.value).toBe(MEMORY_SCHEMA_VERSION);
  });

  it('已经是 summary 的条目不会被删', async () => {
    await db.memories.put({ ...oldRow('s1'), tier: 'summary' });
    const r = await migrateMemorySchema(db);
    expect(r.deleted).toBe(0);
    expect(await db.memories.get('s1')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```ts
import { db as liveDb, type DshDB } from './db';
import { MEMORY_SCHEMA_VERSION, SETTING_MEMORY_SCHEMA } from './types';

/**
 * 一次性迁移：旧版把 AI 回复里的「近期/永久记忆」存进了 memories 表，
 * 新版改成只放摘要。旧条目一律清掉。
 *
 * 一定要逐条 delete：clear() 走的是 deleteRange，而 outbox 收敛点刻意不对它产生墓碑，
 * 云端那份会在别的装置被拉回来（踩过）。
 */
export async function migrateMemorySchema(target: DshDB = liveDb): Promise<{ deleted: number; ran: boolean }> {
  const marker = await target.settings.get(SETTING_MEMORY_SCHEMA);
  if (marker?.value === MEMORY_SCHEMA_VERSION) return { deleted: 0, ran: false };

  const old = (await target.memories.toArray()).filter((m) => m.tier !== 'summary');
  for (const row of old) await target.memories.delete(row.id);
  await target.settings.put({ key: SETTING_MEMORY_SCHEMA, value: MEMORY_SCHEMA_VERSION });
  return { deleted: old.length, ran: true };
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 旧记忆条目一次性迁移（逐条删产生墓碑）（阶段1/Task3）`

---

### Task 4: 摘要库存取（上限 + 合并）

**Files:**
- Modify: `src/core/storage/memoryStore.ts`
- Test: `src/core/storage/memoryStore.test.ts`（改）

**Interfaces:**
- Consumes: `MemoryRecord`（Task 1）
- Produces:
  - `async function listSummaries(chatId: string): Promise<MemoryRecord[]>`（按 order 升序，只回 `tier === 'summary'`）
  - `async function addSummary(input: { chatId: string; userText?: string; assistantText?: string; text: string; dateLabel: string; fromMessageId?: string; toMessageId?: string; messageCount?: number; origin: MemoryOrigin }): Promise<MemoryRecord>`
  - `async function trimSummaries(chatId: string): Promise<{ merged: number }>`（超过 `SUMMARY_KEEP` 时把最老 `SUMMARY_MERGE_BATCH` 条本地拼接成一条 `origin: 'merged'`）
  - `async function deleteSummary(id: string): Promise<void>`（= 旧 `deleteMemory`）
  - `async function updateSummaryText(id: string, text: string, userText?: string, assistantText?: string): Promise<void>`
  - **删除** `ingestMemories` / `toMemoryItems`（调用点由 Task 7 清）

- [ ] **Step 1: 写失败测试**（新增用例，照抄）

```ts
it('摘要超过 20 条时，最老 5 条合并成一条（保留分段与时间范围）', async () => {
  for (let i = 1; i <= 21; i += 1) {
    await addSummary({
      chatId: 'c1', userText: `用户${i}`, assistantText: `叙事${i}`, text: `用户：用户${i}\n叙事：叙事${i}`,
      dateLabel: `10-${String(i).padStart(2, '0')}`, origin: 'model', order: i,
    });
  }
  const r = await trimSummaries('c1');
  expect(r.merged).toBe(1);
  const list = await listSummaries('c1');
  expect(list).toHaveLength(17);            // 21 - 5 + 1
  expect(list[0].origin).toBe('merged');
  expect(list[0].text).toContain('用户1');
  expect(list[0].text).toContain('叙事5');
  expect(list[0].dateLabel).toContain('10-01');
  expect(list[0].dateLabel).toContain('10-05');
});
```

（`addSummary` 增加可选 `order`，没给就用 `max(order)+1`。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`memoryStore.ts` 重写：`listSummaries` / `addSummary` / `trimSummaries` / `deleteSummary` / `updateSummaryText`；`trimSummaries` 用本地拼接，**不调模型**）
- [ ] **Step 4: 跑测试确认通过**（此时 `useSession` 仍在用 `toMemoryItems`，Task 7 会换掉；本步允许 build 报错，但 test 必须过——若 build 阻塞，则本任务同时把 `useSession` 改成 `listSummaries` + `toSummaryItems` 的最小实现）
- [ ] **Step 5: commit** `feat: 摘要库存取与 20 条上限合并（阶段1/Task4）`

---

### Task 5: 装配层（MOD / 摘要 / 移除简介 / 不剥记忆块）

**Files:**
- Modify: `src/core/assembler/assemble.ts`
- Modify: `src/core/cards/regex.ts`（`stripMemoryAndThink` → `stripThink`，保留旧名作 deprecated 转发）
- Test: `src/core/assembler/assemble.test.ts`、`src/core/cards/regex.test.ts`

**Interfaces:**
- Consumes: `AssembleInput.summaries`、`AssembleInput.mods`（Task 1）
- Produces: `assemble()` 的新条目顺序（spec §3.1）；`stripThink(raw: string): string`

- [ ] **Step 1: 写失败测试**

```ts
it('MOD 接在卡片提示词之后（system 35），且在主人公设定之前', () => {
  const r = assemble({ ...base, mods: [{ id: 'mod1', name: '破甲', content: 'MOD内容', order: 1 }] });
  const modIdx = r.entries.findIndex((e) => e.source === 'mod');
  const cardIdx = r.entries.findIndex((e) => e.source === 'card-system' && e.content.includes('主提示词'));
  expect(modIdx).toBeGreaterThan(cardIdx);
  expect(r.entries[modIdx].position).toBe('system');
  expect(r.entries[modIdx].priority).toBe(35);
});

it('简介不再注入提示词', () => {
  const r = assemble({ ...base, card: { ...base.card, description: '这是一段简介' } });
  expect(r.entries.some((e) => e.content.includes('这是一段简介'))).toBe(false);
});

it('摘要注入在历史之前，而且明确标注不是最新消息', () => {
  const r = assemble({ ...base, summaries: [{ id: 's1', text: '[用户] 甲\n[叙事] 乙', dateLabel: '10-01', rangeLabel: '第 1–4 条' }] });
  const sumIdx = r.entries.findIndex((e) => e.source === 'memory');
  const firstHistory = r.entries.findIndex((e) => e.source === 'history');
  expect(sumIdx).toBeLessThan(firstHistory);
  expect(r.entries[sumIdx].position).toBe('before-history');
  expect(r.entries[sumIdx].priority).toBeGreaterThanOrEqual(200);
  expect(r.entries[sumIdx].content).toContain('不是最新消息');
  expect(r.entries[sumIdx].content).toContain('以下是最近的原文对话');
});

it('stripThink 只剥注释、不剥记忆块', () => {
  const raw = '<!--<think>想一下</think>-->\n<details><summary>近期记忆</summary>[1]（10-01）某事</details>';
  const out = stripThink(raw);
  expect(out).not.toContain('想一下');
  expect(out).toContain('近期记忆');
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```ts
// assemble.ts 关键改动
push('card-pre', 'pre', applyMacros(card.pre, input.macros));
push('config-prompt', 'system', applyMacros(config.prompt, input.macros), 'system', 10);
push('config-pre', 'system', applyMacros(config.prePrompt, input.macros), 'system', 20);
push('card-system', 'system', applyMacros(card.prompt, input.macros), 'system', 30);
// ← 原本的 card.description（priority 40）整行删除
for (const m of input.mods ?? []) {
  push('mod', 'system', applyMacros(m.content, input.macros), 'system', 35);
}
push('card-system', 'system', applyMacros(card.persona, input.macros), 'system', 41);
push('card-system', 'system', applyMacros(card.scenario, input.macros), 'system', 42);
push('chat-setup', 'system', input.setup ?? '', 'system', 45);
// ...世界书、历史不变...

// 摘要：紧贴历史之前
const summaries = input.summaries ?? [];
if (summaries.length > 0) {
  const body = summaries.map((s) => `— ${s.dateLabel}${s.rangeLabel ? '（' + s.rangeLabel + '）' : ''} —\n${s.text}`).join('\n\n');
  push('memory', 'before-history',
    '【更早的对话摘要 · 以下内容发生在当前对话之前，不是最新消息】\n' + body +
    '\n\n【以上是更早的摘要，以下是最近的原文对话】',
    'system', 200);
}
// 旧的 perma/recent 两段注入整段删除
```

- [ ] **Step 4: 跑测试确认通过**；`npm run build` 无错
- [ ] **Step 5: commit** `feat: 装配层支持 MOD 与摘要、移除简介注入（阶段1/Task5）`

---

### Task 6: 压缩请求 `summarize.ts`

**Files:**
- Create: `src/core/assembler/summarize.ts`
- Test: `src/core/assembler/summarize.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter.streamChat`、`ProviderConfig`、`ChatRequest`
- Produces:
  - `interface SummaryPart { userText: string; assistantText: string }`
  - `function buildSummaryPrompt(batch: { role: 'user' | 'assistant'; content: string }[], previousTail?: string): string`
  - `function parseSummaryParts(raw: string): SummaryPart`
  - `async function summarizeBatch(input: { adapter: ProviderAdapter; cfg: ProviderConfig; model: string; batch: { role: 'user' | 'assistant'; content: string }[]; previousTail?: string; signal?: AbortSignal }): Promise<SummaryPart>`
  - `function skeletonSummary(batch: { role: 'user' | 'assistant'; content: string }[], fromIndex: number, toIndex: number): SummaryPart`

- [ ] **Step 1: 写失败测试**

```ts
it('解析「用户：/叙事：」两段', () => {
  const raw = '用户：他选了 A\n叙事：走廊尽头的灯灭了。';
  expect(parseSummaryParts(raw)).toEqual({ userText: '他选了 A', assistantText: '走廊尽头的灯灭了。' });
});

it('拆不出标记时整段当叙事，userText 留空', () => {
  const raw = '他们走进了房间。';
  const p = parseSummaryParts(raw);
  expect(p.userText).toBe('');
  expect(p.assistantText).toBe('他们走进了房间。');
});

it('提示词里带上一批消息与上一条摘要尾巴', () => {
  const p = buildSummaryPrompt([{ role: 'user', content: '我推开门' }, { role: 'assistant', content: '门后是一片黑' }], '上次他们还在楼下');
  expect(p).toContain('我推开门');
  expect(p).toContain('门后是一片黑');
  expect(p).toContain('上次他们还在楼下');
  expect(p).toContain('用户：');
  expect(p).toContain('叙事：');
  expect(p).toContain('200 字');
});

it('骨架摘要包含条数范围与用户输入片段', () => {
  const p = skeletonSummary([{ role: 'user', content: '我推开门走进走廊' }], 3, 4);
  expect(p.assistantText).toContain('第 3–4 条');
  expect(p.assistantText).toContain('我推开门走进走廊');
  expect(p.userText).toBe('');
});

it('summarizeBatch 把 adapter 吐出的文本拼起来并解析', async () => {
  const adapter = fakeAdapter(['用户：选了 A', '\n叙事：灯灭了。']);
  const out = await summarizeBatch({ adapter, cfg: cfgStub, model: 'm', batch: [{ role: 'user', content: 'x' }] });
  expect(out.userText).toBe('选了 A');
  expect(out.assistantText).toBe('灯灭了。');
});
```

（`fakeAdapter` 用 `createMockAdapter` 的风味自己写 5 行即可；`cfgStub = { id: 'mock', baseUrl: '', apiKey: '', extraHeaders: {} }`。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（提示词照抄 spec §2.3；`summarizeBatch` 用 `for await (const ev of adapter.streamChat(...))`，只收 `type==='text'`，`signal` 透传；每段超过 `SUMMARY_MAX_CHARS` 截断）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 摘要压缩请求与解析（阶段1/Task6）`

---

### Task 7: 会话串接（窗口 → 摘要 → 主生成；锁发送；HUD 数据）

**Files:**
- Modify: `src/state/useSession.ts`
- Modify: `src/core/storage/db.ts`（`chats` 不变；若需要记「这批失败了几次」用 `settings` 或内存 Map，本任务用内存 Map + 摘要表 pending 标记）
- Test: `src/state/useSession.test.ts`（改+增）

**Interfaces:**
- Consumes: `computeWindow`（T2）、`migrateMemorySchema`（T3）、`listSummaries/addSummary/trimSummaries`（T4）、`assemble`（T5）、`summarizeBatch/skeletonSummary`（T6）
- Produces（SessionState 新增）：
  - `summarizing: boolean`
  - `stopSummarize(): void`
  - `preview(): Promise<{ totalTokens: number; budget: number; rows: { label: string; tokens: number }[]; droppedHistory: number; droppedWorldbook: number; windowCount: number; windowLimit: number | null }>`
  - `send()` 顺序改为：算窗口 → 需要则先压缩（`summarizing=true`，期间 `send()` 直接 return）→ 主生成
  - `init()` 加幂等守卫：`if (get().ready) return;`（切页面 bug 的根治）

- [ ] **Step 1: 写失败测试**

```ts
it('init 是幂等的：切回聊天页不会把 streaming / draft 清掉（回归：回复被截停、停止按钮消失）', async () => {
  await useSession.getState().init();
  useSession.setState({ streaming: true, draft: '吐到一半' });
  await useSession.getState().init();
  expect(useSession.getState().streaming).toBe(true);
  expect(useSession.getState().draft).toBe('吐到一半');
});

it('窗口外的交换会被压成摘要；窗口内的原文不剥离记忆块', async () => {
  // 用 mock adapter；window limit 设 2
  await db.settings.put({ key: 'contextMessageLimit', value: '2' });
  await db.settings.put({ key: 'contextMode', value: 'recent' });
  await useSession.getState().init();
  for (let i = 0; i < 4; i += 1) await useSession.getState().send(`第${i}句`);
  const summaries = await listSummaries(useSession.getState().chatId!);
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries[0].assistantText || summaries[0].text).toContain('叙事');
});

it('压缩期间禁止发送', async () => {
  useSession.setState({ summarizing: true });
  await useSession.getState().send('不该送出去');
  expect(useSession.getState().streaming).toBe(false);
});

it('preview() 的数字来自真实的 assemble（与发送时一致）', async () => {
  await useSession.getState().init();
  await useSession.getState().send('你好');
  const p = await useSession.getState().preview();
  expect(p.totalTokens).toBeGreaterThan(0);
  expect(p.rows.some((r) => r.label.includes('历史'))).toBe(true);
  expect(p.windowLimit).toBe(6);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（抽出 `buildPromptParts()` 同时供 `send()` 与 `preview()` 使用；摘要失败计数用模块层 `Map<string, number>`，连续 3 次 → `skeletonSummary`；`summarize` 期间 `currentAbort` 复用同一套取消；`summarizing` 结束后 `trimSummaries()`）
- [ ] **Step 4: 跑测试确认通过**；`npm run build` 无错
- [ ] **Step 5: commit** `feat: 发送前先压缩窗口外交换 + 锁发送 + preview（阶段1/Task7）`

---

## 阶段 2：UI

### Task 8: 设置页

**Files:**
- Modify: `src/ui/settings/SettingsScreen.tsx`
- Create: `src/ui/settings/ModSection.tsx`
- Modify: `src/ui/settings/SettingsScreen.test.tsx`

- [ ] **Step 1: 写失败测试**（上下文模式单选、N 输入保存时校验、模型配置「编辑」载回表单、API Key 空值校验放行本机地址、测试成功文案不含模型数、MOD 新增/开关/删除）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - 删「近期记忆保留条数」整个 label 与 `memoryLimit` 逻辑
  - 加「上下文模式」（两个药丸按钮）+「最近 N 条」输入（校验 1–100，只在保存时检查）
  - 模型配置参数滑块加 `contextLength`（label「上下文大小」，step 1024，min 2048，max 2000000）
  - 模型配置列表每项加「编辑」→ 载入 `presetModel/params/capabilities/providerId`
  - `onSaveProvider` 校验：`apiKey` 为空时，若 `baseUrl` 不是本机/内网则 toast 拒绝保存
  - `onTest` 成功文案改成「连接成功」
  - 新增 `<ModSection />`
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 设置页上下文与 MOD（阶段2/Task8）`

---

### Task 9: MOD 仓库 + 同步

**Files:**
- Create: `src/core/storage/modRepo.ts`
- Modify: `src/core/sync/kinds.ts`、`src/core/sync/kinds.test.ts`、`src/core/storage/db.ts`、`src/core/storage/backup.ts`、`src/core/storage/types.ts`
- Test: `src/core/storage/modRepo.test.ts`

- [ ] **Step 1: 写失败测试**（CRUD + `listEnabledMods()` 按 order 排序 + `SYNC_TABLES` 有 15 项 + 备份导出/导入含 mods）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```ts
// db.ts
this.version(3).stores({ mods: 'id, enabled, order' });
// kinds.ts
export type SyncKind = ... | 'mod';
SYNC_TABLES = { ..., mod: 'mods' };
// backup.ts：exportAll 加 mods，importAll 清空+写回也要加（漏了会丢 MOD）
// kinds.test.ts：expect(tables).toHaveLength(14) → 15
```
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: MOD 表与同步（阶段2/Task9）`

---

### Task 10: 聊天页（HUD + 图标按钮 + 从这里重开 + 复制反馈）

**Files:**
- Create: `src/ui/play/ContextHud.tsx`、`src/ui/play/ScrollButtons.tsx`
- Modify: `src/ui/play/PlayScreen.tsx`、`src/ui/play/MessageBubble.tsx`
- Modify: `src/state/useSession.ts`（`branchTo` 后自动生成）
- Test: `src/ui/play/PlayScreen.test.tsx`、`src/state/useSession.test.ts`

- [ ] **Step 1: 写失败测试**
  - 「从这里重开」之后会自动多出一条新的 AI 回复（`messages.length` 增加且最后一条是 assistant）
  - 复制按钮点击后出现「已复制」toast（`useNav` 的 toast）
  - 滚动区超过一屏时出现「回到顶部 / 回到底部」两个按钮（data-testid `scroll-top` / `scroll-bottom`）
  - HUD 显示「上下文 n/6 条」
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`branchTo` 改成：移动指针 → 若目标是 user 消息则 `streamReply` 生成新回复；`ScrollButtons` 用两个圆形图标按钮固定在聊天区右下角；`ContextHud` 调 `preview()` 并在数据变化时刷新）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 聊天页 HUD、图标按钮、从这里重开、复制反馈（阶段2/Task10）`

---

### Task 11: 记忆库面板 + 对话列表

**Files:**
- Modify: `src/ui/play/PlayScreen.tsx`（记忆库 sheet 改摘要）
- Modify: `src/state/useSession.ts`（`newChat` 默认名）
- Test: `src/ui/play/PlayScreen.test.tsx`

- [ ] **Step 1: 写失败测试**（记忆库面板显示摘要的时间范围与来源；摘要可编辑/删除；新建对话名字是「对话1」「对话2」；对话列表的改名/删除是右侧图标按钮而不是下一行）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 记忆库面板改摘要、对话列表右侧图标（阶段2/Task11）`

---

## 阶段 3：子系统

### Task 12: 同步冲突（登录预检 + 面板）

**Files:**
- Modify: `src/state/useSync.ts`、`src/core/sync/engine.ts`（导出 `snapshotContentTables` / `restoreSnapshot` 供「以本地为准」用）
- Create: `src/ui/settings/ConflictPanel.tsx`
- Modify: `src/ui/settings/AccountSection.tsx`
- Test: `src/state/useSync.test.ts`、`src/ui/settings/AccountSection.test.tsx`

- [ ] **Step 1: 写失败测试**（本地空→不弹；云端空→不弹；两边都非空→`status` 变 `'needs-choice'` 且有 `pendingChoice`；选「以云端为准」走 pull；选「以本地为准」按「快照→拉→覆盖→推」四步且本地内容最终在云端）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`SyncStatus` 增加 `'needs-choice'`；`resolveConflictChoice(choice)`；`ConflictPanel` 解密 `syncConflicts` 显示并可「覆盖回去」）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 登录冲突取舍与冲突面板（阶段3/Task12）`

---

### Task 13: 图片（封面 + 头像）

**Files:**
- Create: `src/core/storage/image.ts`、`src/ui/cards/ImageSlots.tsx`
- Modify: `src/ui/cards/CardEditorScreen.tsx`、`src/ui/cards/CardListScreen.tsx`、`src/ui/play/MessageBubble.tsx`、`src/ui/play/PlayScreen.tsx`、`src/core/cards/package.ts`（`packCard(pkg, { includeAssets })`）、`src/ui/cards/CardListScreen.tsx`（导出时弹选择）
- Test: `src/core/storage/image.test.ts`、`src/ui/cards/CardEditorScreen.test.tsx`

- [ ] **Step 1: 写失败测试**
  - PNG magic byte 通过、伪装的 `.png`（内容是 HTML）被拒
  - SVG 被拒
  - 超过 2 MB 被拒
  - 没登录时上传按钮 `disabled`，但已有图片仍然渲染（`<img>` 存在）
  - `packCard(pkg, { includeAssets: false })` 的 zip 里没有 `assets/*`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`sniffImageMime(bytes)`、`assertImageFile(file)`、`compressImage(file, maxEdge)` 用 `createImageBitmap` + `OffscreenCanvas`（jsdom 没有 → 测试里注入假实现或只测校验函数）；`ImageSlots` 两个槽；卡片列表渲染封面、聊天渲染头像）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: commit** `feat: 卡片封面与聊天头像（阶段3/Task13）`

---

## 阶段 4：收尾

### Task 14: 快速批次剩余项 + 文档 + 验证 + 部署

**Files:**
- Modify: `src/ui/cards/CardEditorScreen.tsx`（删三个字段、提示词改名与顺序说明、简介 label）
- Modify: `src/core/storage/seedContent.ts`（提示词措辞中性化 + 版本升级）
- Modify: `AGENTS.md`、`README.md`
- Modify: `scripts/cdp-ui-check.mjs`（新增 HUD / 图标按钮 / 记忆库摘要 / console 零警告断言）

- [ ] **Step 1: 快速批次剩项**：删「主人公设定/前情提要/开场白」输入框；简介 label 改「简介（只在卡片列表显示）」；卡片侧「卡片前缀词」/全局侧「全局前缀词」+ 顺序说明；内置卡提示词措辞 + 版本升级
- [ ] **Step 2: 全量回归**：`npm run test`、`npm run build`
- [ ] **Step 3: 更新 `AGENTS.md`**（测试基线、新坑：摘要按对/逐条删墓碑/窗口对齐/图片校验）与 `README.md`（功能清单）
- [ ] **Step 4: 无头浏览器实测**：`node scripts/cdp-ui-check.mjs <port> <url>`，`"pass": true` 且 console 零警告
- [ ] **Step 5: 部署 + 冒烟**：worker `wrangler deploy`、前端 build 后 `wrangler pages deploy`，正式站跑探针
- [ ] **Step 6: commit（中文）并输出完成表**（逐项：做了什么 / 怎么验证 / 对应 commit）

---

## 自审记录

**1. Spec 覆盖**：spec §1→T2/T7/T8、§2→T3/T4/T6/T7、§3→T5、§4→T3、§5→T7/T10、§6→T12、§7→T8/T9、§8→T13、§9→T8/T10/T11/T14、§10→已在各任务注释、§11→各任务测试步骤、§12→T14。

**2. 占位符扫描**：无 TBD / TODO；所有代码步骤都带真实代码或明确改动点。

**3. 类型一致性**：`computeWindow` / `buildExchanges`（T2）、`migrateMemorySchema`（T3）、`addSummary` / `listSummaries` / `trimSummaries`（T4）、`SummaryItem` / `ModItem`（T1）、`summarizeBatch` / `skeletonSummary` / `parseSummaryParts`（T6）、`preview()` / `summarizing` / `stopSummarize()`（T7）在各任务间签名一致。

**注意**：Task 1 与 Task 4 都提到「先做最小改动让 build 过」，执行时以**先跑通测试、再修 build** 为准；两个任务之间允许 build 短暂报错，但进入 Task 5 之前必须 build 无错。
