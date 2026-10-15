import { db, newId } from './db';
import type { ModRecord } from './types';
import type { ModItem } from '../assembler/types';

/** 全部 MOD，按 order 升序 */
export async function listMods(): Promise<ModRecord[]> {
  const all = await db.mods.toArray();
  return all.sort((a, b) => a.order - b.order);
}

/** 打开着的 MOD，转成装配层要的 ModItem */
export async function listEnabledMods(): Promise<ModItem[]> {
  const all = await listMods();
  return all
    .filter((m) => m.enabled && m.content.trim())
    .map((m) => ({ id: m.id, name: m.name, content: m.content, order: m.order }));
}

export async function saveMod(input: {
  id?: string;
  name: string;
  content: string;
  enabled?: boolean;
  order?: number;
}): Promise<string> {
  const id = input.id ?? newId('mod_');
  const existing = input.id ? await db.mods.get(input.id) : undefined;
  const all = await listMods();
  const order = input.order ?? existing?.order ?? all.reduce((max, m) => Math.max(max, m.order), -1) + 1;
  const row: ModRecord = {
    id,
    name: input.name.trim() || '未命名 MOD',
    content: input.content,
    enabled: input.enabled ?? existing?.enabled ?? true,
    order,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await db.mods.put(row);
  return id;
}

export async function setModEnabled(id: string, enabled: boolean): Promise<void> {
  const row = await db.mods.get(id);
  if (!row) return;
  await db.mods.put({ ...row, enabled, updatedAt: Date.now() });
}

export async function deleteMod(id: string): Promise<void> {
  await db.mods.delete(id);
}

export async function countEnabledMods(): Promise<number> {
  return (await listEnabledMods()).length;
}
