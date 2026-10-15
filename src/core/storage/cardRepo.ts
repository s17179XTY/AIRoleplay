import { db, newId } from './db';
import type { CardRecord } from './types';
import { findText, packCard, unpackCard, type CardPackage } from '../cards/package';
import { CARD_SPEC, parseWorldbookFile, parseRegexFile, serializeCardJson } from '../cards/spec';
import type { WbEntryInput } from '../assembler/types';
import type { RegexScriptJson } from '../cards/spec';
import { seedPackage } from './seedPackage';

export async function saveCardPackage(pkg: CardPackage): Promise<string> {
  const id = pkg.json.id || newId('card_');
  pkg.json.id = id;
  const now = Date.now();
  const existing = await db.cards.get(id);
  const record: CardRecord = {
    id,
    name: pkg.json.name || '未命名卡片',
    author: pkg.json.author || '',
    version: pkg.json.version || '1.0.0',
    description: pkg.json.description || '',
    tags: pkg.json.tags ?? [],
    coverAssetId: existing?.coverAssetId,
    source: existing?.source ?? 'local',
    spec: CARD_SPEC,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.cards.put(record);

  await db.cardFiles.where('cardId').equals(id).delete();
  await db.cardFiles.put({ cardId: id, path: 'card.json', kind: 'json', text: serializeCardJson(pkg.json) });
  for (const f of pkg.texts) {
    await db.cardFiles.put({ cardId: id, path: f.path, kind: kindOf(f.path), text: f.text });
  }
  for (const a of pkg.assets) {
    const assetId = id + ':' + a.path;
    const buffer = a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength) as ArrayBuffer;
    await db.assets.put({ id: assetId, mime: a.mime, size: a.bytes.byteLength, bytes: buffer });
    await db.cardFiles.put({ cardId: id, path: a.path, kind: 'asset', assetId });
    if (pkg.json.cover === a.path) await db.cards.update(id, { coverAssetId: assetId });
    if (pkg.json.avatar === a.path) await db.cards.update(id, { avatarAssetId: assetId });
  }
  return id;
}

function kindOf(path: string): 'json' | 'html' | 'css' | 'template' | 'worldbook' | 'regex' | 'asset' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.md')) return 'template';
  if (lower.endsWith('worldbook.json')) return 'worldbook';
  if (lower.endsWith('regex.json')) return 'regex';
  return 'json';
}

export async function loadCardPackage(cardId: string): Promise<CardPackage | null> {
  const record = await db.cards.get(cardId);
  if (!record) return null;
  const rows = await db.cardFiles.where('cardId').equals(cardId).toArray();
  const jsonRow = rows.find((r) => r.path === 'card.json');
  const json = jsonRow?.text ? (JSON.parse(jsonRow.text) as CardPackage['json']) : null;
  if (!json) return null;
  const texts = rows
    .filter((r) => r.path !== 'card.json' && r.text !== undefined && r.kind !== 'asset')
    .map((r) => ({ path: r.path, text: r.text as string }));
  const assets: CardPackage['assets'] = [];
  for (const r of rows.filter((x) => x.kind === 'asset')) {
    if (!r.assetId) continue;
    const asset = await db.assets.get(r.assetId);
    if (!asset) continue;
    assets.push({ path: r.path, mime: asset.mime, bytes: new Uint8Array(asset.bytes) });
  }
  json.id = cardId;
  return { json, texts, assets };
}

export async function ensureSeedCard(): Promise<string> {
  const pkg = seedPackage();
  const existing = await db.cards.get(pkg.json.id);
  if (existing) {
    const loaded = await loadCardPackage(existing.id);
    const isBuiltinDemo = existing.author === pkg.json.author;
    // 已损坏（老版本只写了卡片行、没有写 card.json）→ 重建；
    // 内置演示卡版本升级 → 覆盖；用户自己改过的卡片不动。
    if (loaded && !(isBuiltinDemo && loaded.json.version !== pkg.json.version)) return existing.id;
  }
  return saveCardPackage(pkg);
}

export async function listCards(): Promise<CardRecord[]> {
  const all = await db.cards.toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteCard(cardId: string): Promise<void> {
  const rows = await db.cardFiles.where('cardId').equals(cardId).toArray();
  for (const r of rows) if (r.assetId) await db.assets.delete(r.assetId);
  await db.cardFiles.where('cardId').equals(cardId).delete();
  await db.chats.where('cardId').equals(cardId).delete();
  await db.cards.delete(cardId);
}

export function worldbookOf(pkg: CardPackage): WbEntryInput[] {
  const text = findText(pkg, pkg.json.worldbook);
  if (!text) return [];
  try {
    return parseWorldbookFile(text);
  } catch {
    return [];
  }
}

export function regexOf(pkg: CardPackage): RegexScriptJson[] {
  const text = findText(pkg, pkg.json.regex);
  if (!text) return [];
  try {
    return parseRegexFile(text);
  } catch {
    return [];
  }
}

export function uiHtmlOf(pkg: CardPackage): string | null {
  const entry = pkg.json.ui?.entry;
  return findText(pkg, entry) ?? null;
}

export { packCard, unpackCard };
