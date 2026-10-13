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
