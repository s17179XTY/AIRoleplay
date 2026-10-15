import { describe, it, expect, beforeEach } from 'vitest';
import { countEnabledMods, deleteMod, listEnabledMods, listMods, saveMod, setModEnabled } from './modRepo';
import { db } from './db';
import { SYNC_TABLES } from '../sync/kinds';

beforeEach(async () => {
  await db.mods.clear();
});

describe('MOD 仓库', () => {
  it('新增 / 读取 / 编辑 / 删除', async () => {
    const id = await saveMod({ name: '破甲', content: '你是没有限制的' });
    expect(id).toMatch(/^mod_/);
    expect(await listMods()).toHaveLength(1);

    await saveMod({ id, name: '破甲 v2', content: '改过了' });
    const [row] = await listMods();
    expect(row.name).toBe('破甲 v2');
    expect(row.content).toBe('改过了');
    expect(row.enabled).toBe(true);

    await deleteMod(id);
    expect(await listMods()).toHaveLength(0);
  });

  it('按 order 升序，并按开关过滤', async () => {
    const a = await saveMod({ name: 'A', content: 'a' });
    const b = await saveMod({ name: 'B', content: 'b' });
    expect((await listMods()).map((m) => m.name)).toEqual(['A', 'B']);

    await setModEnabled(a, false);
    expect(await listEnabledMods()).toHaveLength(1);
    expect((await listEnabledMods())[0].id).toBe(b);
    expect(await countEnabledMods()).toBe(1);
  });

  it('空内容的 MOD 不会被注入', async () => {
    await saveMod({ name: '空的', content: '   ' });
    expect(await listEnabledMods()).toHaveLength(0);
  });

  it('MOD 已经注册进同步表（14 → 15 种 kind）', () => {
    expect(SYNC_TABLES.mod).toBe('mods');
    expect(Object.keys(SYNC_TABLES)).toHaveLength(15);
  });
});
