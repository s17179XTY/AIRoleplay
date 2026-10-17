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
    // 头像也要沿用：record 是整个对象覆盖写入，漏掉这一栏就等于「重存一次头像没了」。
    // 下面循环里的 `json.avatar === path` 只能补回「字节也在包里」的情况，
    // 一旦这次保存没带 assets（导出包默认不含图、草稿从别处来），就永远补不回来。
    avatarAssetId: existing?.avatarAssetId,
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
  // card.json 里的 cover / avatar 可能被旧版本编辑器抹掉，或与真实文件名对不上（导入的卡）。
  // 用 record 里的引用把界面要解析的字段补回来——只补内存里的对象，不写回数据库。
  const available = new Set(assets.map((a) => a.path));
  backfillImageRefs(cardId, record, json, available);
  return { json, texts, assets };
}

/** `<cardId>:<path>` → `<path>`；格式不同（旧数据 / 手工写库）就退回「取第一个冒号之后」 */
function assetPathOf(cardId: string, assetId: string | undefined): string | undefined {
  if (!assetId) return undefined;
  const prefix = cardId + ':';
  if (assetId.startsWith(prefix)) return assetId.slice(prefix.length) || undefined;
  const cut = assetId.indexOf(':');
  return (cut >= 0 ? assetId.slice(cut + 1) : assetId) || undefined;
}

/**
 * 卡片图片引用的自愈：
 * 只要 record 记着这张图（coverAssetId / avatarAssetId）而 card.json 的字段空了、
 * 或者指向的路径在卡片包里根本不存在，就用 record 的路径顶上。
 */
function backfillImageRefs(
  cardId: string,
  record: CardRecord,
  json: CardPackage['json'],
  available: Set<string>,
): void {
  const fill = (key: 'cover' | 'avatar', assetId: string | undefined) => {
    const stored = json[key];
    if (stored && available.has(stored)) return; // card.json 自己就对，别动它
    const path = assetPathOf(cardId, assetId);
    if (!path || !available.has(path)) return;
    json[key] = path;
  };
  fill('cover', record.coverAssetId);
  fill('avatar', record.avatarAssetId);
}

export async function ensureSeedCard(): Promise<string> {
  const pkg = seedPackage();
  const existing = await db.cards.get(pkg.json.id);
  if (existing) {
    const loaded = await loadCardPackage(existing.id);
    const isBuiltinDemo = existing.author === pkg.json.author;
    // 已损坏（老版本只写了卡片行、没有写 card.json）→ 重建；
    // 内置演示卡版本升级 → 覆盖；用户自己改过的卡片不动。
    if (loaded && !(isBuiltinDemo && loaded.json.version !== pkg.json.version)) {
      /*
       * 版本没变，但有些内建文件可能「被同步弄丢了」——典型是旧版 blob 金钥对不上，
       * 新装置拉不到互动页，卡片打开是空的。这里只补 card.json 仍然引用、但本地已没有的
       * 内建文件；使用者主动删掉的页面/世界书（json 里不再引用）不会被复活，改过的内容也不会被覆盖。
       */
      if (isBuiltinDemo && healMissingBuiltinFiles(loaded, pkg)) {
        await saveCardPackage(loaded);
      }
      return existing.id;
    }
  }
  return saveCardPackage(pkg);
}

/**
 * 把「内建卡 seed 里有、card.json 也还引用着、但本地文件已经不见了」的档案补回去。
 * 这些是平台内建内容（互动页 / 世界书 / 封面），不是使用者上传的图；
 * 使用者上传的封面/头像等自订档案不走这里（救不回来就让使用者重传）。
 */
function healMissingBuiltinFiles(loaded: CardPackage, seed: CardPackage): boolean {
  let changed = false;
  const referencedTexts = new Set(
    [loaded.json.worldbook, loaded.json.regex, loaded.json.ui?.entry, loaded.json.promptTemplate]
      .filter((p): p is string => Boolean(p)),
  );
  for (const file of seed.texts) {
    if (!referencedTexts.has(file.path)) continue;
    if (loaded.texts.some((t) => t.path === file.path)) continue;
    loaded.texts.push({ ...file });
    changed = true;
  }
  const referencedAssets = new Set(
    [loaded.json.cover, loaded.json.avatar].filter((p): p is string => Boolean(p)),
  );
  for (const asset of seed.assets) {
    if (!referencedAssets.has(asset.path)) continue;
    if (loaded.assets.some((a) => a.path === asset.path)) continue;
    loaded.assets.push({ ...asset });
    changed = true;
  }
  return changed;
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