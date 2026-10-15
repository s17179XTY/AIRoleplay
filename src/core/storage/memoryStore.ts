import { db, newId } from './db';
import type { MemoryRecord } from './types';
import type { MemoryItem, SummaryItem } from '../assembler/types';
import type { ExtractedMemory } from '../render/extract';

export async function listMemories(chatId: string): Promise<MemoryRecord[]> {
  const all = await db.memories.where('chatId').equals(chatId).toArray();
  return all.sort((a, b) => a.order - b.order);
}

/** 摘要库的条目按 order 升序（旧的在前，注入时也是这个方向） */
export async function listSummaries(chatId: string): Promise<MemoryRecord[]> {
  const all = await db.memories.where('chatId').equals(chatId).toArray();
  return all.filter((r) => r.tier === 'summary').sort((a, b) => a.order - b.order);
}

export function toSummaryItems(records: MemoryRecord[]): SummaryItem[] {
  return records
    .filter((r) => r.tier === 'summary')
    .map((r) => ({
      id: r.id,
      text: r.text,
      userText: r.userText,
      assistantText: r.assistantText,
      dateLabel: r.dateLabel,
      rangeLabel: r.rangeLabel,
    }));
}

/** @deprecated 旧版近期/永久记忆的映射，只在迁移期还用到 */
export function toMemoryItems(records: MemoryRecord[]): MemoryItem[] {
  const permanent = records.filter((r) => r.tier === 'permanent');
  const recent = records.filter((r) => r.tier === 'recent').slice(-20);
  return [...permanent, ...recent].map((r) => ({
    id: r.id,
    tier: r.tier as 'recent' | 'permanent',
    text: r.text,
    dateLabel: r.dateLabel,
  }));
}

export interface IngestResult { added: number; archived: number; }

export async function ingestMemories(
  chatId: string,
  messageId: string,
  extracted: ExtractedMemory[],
  recentLimit: number,
): Promise<IngestResult> {
  if (extracted.length === 0) return { added: 0, archived: 0 };
  const existing = await listMemories(chatId);
  let order = existing.reduce((max, r) => Math.max(max, r.order), 0);
  const permanentOffset = existing.filter((r) => r.tier === 'permanent').length * 1000;

  let added = 0;
  for (const item of extracted) {
    order += 1;
    await db.memories.add({
      id: newId('mem_'),
      chatId,
      tier: item.tier,
      text: item.text,
      dateLabel: item.dateLabel,
      sourceMessageId: messageId,
      archivedAt: item.tier === 'permanent' ? Date.now() : null,
      order: item.tier === 'permanent' ? permanentOffset + order : order,
    });
    added += 1;
  }

  const recent = (await listMemories(chatId)).filter((r) => r.tier === 'recent');
  if (recent.length <= recentLimit) return { added, archived: 0 };

  const overflow = recent.slice(0, recent.length - recentLimit);
  const merged = overflow
    .map((r) => (r.dateLabel ? '（' + r.dateLabel + '）' : '') + r.text)
    .join('\n');
  const firstDate = overflow[0]?.dateLabel ?? '';
  const lastDate = overflow[overflow.length - 1]?.dateLabel ?? '';
  const range = firstDate && lastDate && firstDate !== lastDate ? firstDate + ' 至 ' + lastDate : firstDate || lastDate;

  const permanentCount = (await listMemories(chatId)).filter((r) => r.tier === 'permanent').length;
  await db.memories.add({
    id: newId('mem_'),
    chatId,
    tier: 'permanent',
    text: merged,
    dateLabel: range,
    sourceMessageId: null,
    archivedAt: Date.now(),
    order: permanentCount,
  });
  for (const r of overflow) await db.memories.delete(r.id);
  return { added, archived: 1 };
}

export async function deleteMemory(id: string): Promise<void> {
  await db.memories.delete(id);
}
