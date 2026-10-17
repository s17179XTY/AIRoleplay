import { db, newId } from './db';
import type { MemoryOrigin, MemoryRecord } from './types';
import { SUMMARY_KEEP, SUMMARY_MERGE_BATCH, SUMMARY_MAX_CHARS } from './types';
import type { MemoryItem, SummaryItem } from '../assembler/types';
import type { ExtractedMemory } from '../render/extract';

/** 本地合并后的条目的字数上限：合并是「唯一的历史载体」，宁长勿丢，不能按单对的 200 字截断 */
const MERGED_MAX_CHARS = SUMMARY_MAX_CHARS * SUMMARY_MERGE_BATCH;

/** 会话里所有记忆条目（含迁移前的旧数据），按 order 升序 */
export async function listMemories(chatId: string): Promise<MemoryRecord[]> {
  const all = await db.memories.where('chatId').equals(chatId).toArray();
  return all.sort((a, b) => a.order - b.order);
}

/** 摘要库条目（旧版的 recent/permanent 不算），按时间（order）升序：注入时也是这个方向 */
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

export interface AddSummaryInput {
  chatId: string;
  text: string;
  dateLabel: string;
  userText?: string;
  assistantText?: string;
  fromMessageId?: string;
  toMessageId?: string;
  messageCount?: number;
  rangeLabel?: string;
  origin: MemoryOrigin;
  order?: number;
  /** 这一条的文本上限：攒够 N 对合成一条时要按 N 放大（默认按单对 200 字） */
  maxChars?: number;
}

function clip(text: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

export async function addSummary(input: AddSummaryInput): Promise<MemoryRecord> {
  const existing = await listSummaries(input.chatId);
  const order = input.order ?? existing.reduce((max, r) => Math.max(max, r.order), 0) + 1;
  const row: MemoryRecord = {
    id: newId('sum_'),
    chatId: input.chatId,
    tier: 'summary',
    text: clip(input.text, input.maxChars),
    userText: input.userText ? clip(input.userText, input.maxChars) : undefined,
    assistantText: input.assistantText ? clip(input.assistantText, input.maxChars) : undefined,
    dateLabel: input.dateLabel,
    order,
    sourceMessageId: input.toMessageId ?? null,
    archivedAt: Date.now(),
    fromMessageId: input.fromMessageId,
    toMessageId: input.toMessageId,
    messageCount: input.messageCount,
    rangeLabel: input.rangeLabel,
    origin: input.origin,
    tokenCount: Math.ceil(input.text.length / 2),
    createdAt: Date.now(),
  };
  await db.memories.put(row);
  return row;
}

export async function updateSummaryText(
  id: string,
  text: string,
  userText?: string,
  assistantText?: string,
): Promise<void> {
  const row = await db.memories.get(id);
  if (!row) return;
  // 手动编辑以使用者写的为准，但给一个整体保险（合并条目的上限，而不是单对的 200 字）
  await db.memories.put({
    ...row,
    text: clip(text, MERGED_MAX_CHARS),
    userText: userText === undefined ? row.userText : clip(userText, MERGED_MAX_CHARS),
    assistantText: assistantText === undefined ? row.assistantText : clip(assistantText, MERGED_MAX_CHARS),
  });
}

export async function deleteSummary(id: string): Promise<void> {
  await db.memories.delete(id);
}

/**
 * 摘要库上限：超过 SUMMARY_KEEP 条时，把最老的 SUMMARY_MERGE_BATCH 条
 * **本地拼接**成一条（不调模型，省钱也不会失败）。
 */
export async function trimSummaries(chatId: string): Promise<{ merged: number }> {
  const list = await listSummaries(chatId);
  if (list.length <= SUMMARY_KEEP) return { merged: 0 };

  const head = list.slice(0, SUMMARY_MERGE_BATCH);
  const users = head.map((r) => (r.userText ? `（${r.dateLabel}）${r.userText}` : '')).filter(Boolean);
  const narratives = head
    .map((r) => (r.assistantText ? `（${r.dateLabel}）${r.assistantText}` : r.userText ? '' : `（${r.dateLabel}）${r.text}`))
    .filter(Boolean);
  const first = head[0]?.dateLabel ?? '';
  const last = head[head.length - 1]?.dateLabel ?? '';
  const range = first && last && first !== last ? `${first} ~ ${last}` : first || last;
  const mergedText =
    (users.length ? '[用户]\n' + users.join('\n') + '\n' : '') +
    (narratives.length ? '[叙事]\n' + narratives.join('\n') : '');

  await addSummary({
    chatId,
    text: clippedJoin(mergedText),
    userText: users.join('\n'),
    assistantText: narratives.join('\n'),
    dateLabel: range,
    rangeLabel: `${head.length} 条摘要合并`,
    fromMessageId: head[0]?.fromMessageId,
    toMessageId: head[head.length - 1]?.toMessageId,
    messageCount: head.reduce((s, r) => s + (r.messageCount ?? 0), 0),
    origin: 'merged',
    order: head[0].order,
    maxChars: MERGED_MAX_CHARS,
  });

  for (const row of head) await db.memories.delete(row.id);
  // 合并后的那一条 order 最小，读回来仍排在最前面
  return { merged: 1 };
}

/** 合并摘要不截断单段（它是唯一的历史载体，宁长勿丢），只做整体保险 */
function clippedJoin(text: string): string {
  return text;
}

/* ------------------------------------------------------------------ *
 * 下面两个是迁移前的旧 API，迁移完成（Task 7）后会被删掉。
 * ------------------------------------------------------------------ */

/**
 * @deprecated 旧版：把 AI 回复里的近期/永久记忆直接追加进表。
 * 新版由摘要库（addSummary）接管 —— 追加语义会让模型每轮重写清单时存出重复条目。
 */
export async function ingestMemories(
  chatId: string,
  messageId: string,
  extracted: ExtractedMemory[],
  recentLimit: number,
): Promise<{ added: number; archived: number }> {
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

/** @deprecated 旧版映射，只在迁移期还用到 */
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

/** @deprecated 旧名，等同 deleteSummary */
export async function deleteMemory(id: string): Promise<void> {
  await deleteSummary(id);
}