import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import {
  DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_MODE, DEFAULT_SUMMARY_BATCH,
  MEMORY_SCHEMA_VERSION, SETTING_CONTEXT_LIMIT, SETTING_CONTEXT_MODE,
  SETTING_MEMORY_SCHEMA, SETTING_SUMMARY_BATCH, SETTING_SUMMARY_ENABLED,
  SUMMARY_KEEP, SUMMARY_MAX_CHARS, SUMMARY_MAX_PAIRS_PER_RUN, SUMMARY_MERGE_BATCH,
  SUMMARY_TARGET_PERCENT, SUMMARY_TRIGGER_MAX, SUMMARY_TRIGGER_MIN, DEFAULT_SUMMARY_TRIGGER,
  type MemoryRecord, type ModRecord,
} from './types';

beforeEach(async () => {
  await db.memories.clear();
});

describe('摘要库与上下文设置的类型/常量', () => {
  it('预设值与 spec 一致', () => {
    expect(DEFAULT_CONTEXT_MODE).toBe('recent');
    expect(DEFAULT_CONTEXT_LIMIT).toBe(6);
    expect(DEFAULT_SUMMARY_BATCH).toBe(1);
    expect(SUMMARY_MAX_CHARS).toBe(200);
    // 一对一项摘要之后条数涨得快，上限放宽到 100（否则很快满库又不停合并）
    expect(SUMMARY_KEEP).toBe(100);
    expect(SUMMARY_MERGE_BATCH).toBe(10);
    // 阈值压缩：默认 90%，可设 50–92（太贴近 100% 会来不及压）
    expect(DEFAULT_SUMMARY_TRIGGER).toBe(90);
    expect(SUMMARY_TRIGGER_MIN).toBe(50);
    expect(SUMMARY_TRIGGER_MAX).toBe(92);
    expect(SUMMARY_TARGET_PERCENT).toBe(75);
    expect(SUMMARY_MAX_PAIRS_PER_RUN).toBe(6);
    expect(MEMORY_SCHEMA_VERSION).toBe('summary-v1');
    expect(SETTING_CONTEXT_MODE).toBe('contextMode');
    expect(SETTING_CONTEXT_LIMIT).toBe('contextMessageLimit');
    expect(SETTING_SUMMARY_ENABLED).toBe('summaryEnabled');
    expect(SETTING_SUMMARY_BATCH).toBe('summaryBatchPairs');
    expect(SETTING_MEMORY_SCHEMA).toBe('memorySchema');
  });

  it('摘要的延伸栏位是非索引栏位：不用升 Dexie 版本也存得回来', async () => {
    const row: MemoryRecord = {
      id: 's1', chatId: 'c1', tier: 'summary', text: '[用户] 甲\n[叙事] 乙',
      userText: '甲', assistantText: '乙', dateLabel: '10-01 ~ 10-02', order: 1,
      sourceMessageId: 'm9', archivedAt: null,
      fromMessageId: 'm1', toMessageId: 'm9', messageCount: 8, origin: 'model', tokenCount: 40,
    };
    await db.memories.put(row);
    const back = await db.memories.get('s1');
    expect(back?.userText).toBe('甲');
    expect(back?.assistantText).toBe('乙');
    expect(back?.origin).toBe('model');
    expect(back?.messageCount).toBe(8);
  });

  it('ModRecord 栏位齐全', () => {
    const m: ModRecord = {
      id: 'mod1', name: '破甲', content: '内容', enabled: true, order: 0, createdAt: 1, updatedAt: 1,
    };
    expect(Object.keys(m).sort()).toEqual(
      ['content', 'createdAt', 'enabled', 'id', 'name', 'order', 'updatedAt'].sort(),
    );
  });
});
