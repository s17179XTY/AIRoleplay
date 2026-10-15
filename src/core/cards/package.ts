import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { parseCardJson, serializeCardJson, type DshCardJson } from './spec';

export interface PackageTextFile { path: string; text: string; }
export interface PackageAsset { path: string; mime: string; bytes: Uint8Array; }

export interface CardPackage {
  json: DshCardJson;
  texts: PackageTextFile[];
  assets: PackageAsset[];
}

export function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * 打成 zip。
 * `includeAssets: false` 时不写入 assets/*（导出卡片默认不含图片：避免夹带文件，
 * 也避免把整个卡片包撑大）；全量备份走的是另一条路（backup.ts，一定会带图）。
 */
export function packCard(pkg: CardPackage, opts: { includeAssets?: boolean } = {}): Uint8Array {
  const includeAssets = opts.includeAssets !== false;
  const files: Record<string, Uint8Array> = {};
  files['card.json'] = strToU8(serializeCardJson(pkg.json));
  for (const f of pkg.texts) files[f.path] = strToU8(f.text);
  if (includeAssets) for (const a of pkg.assets) files[a.path] = a.bytes;
  return zipSync(files, { level: 6 });
}

export function unpackCard(bytes: Uint8Array): CardPackage {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('卡片包损坏：不是有效的 zip 文件');
  }
  const cardEntry = entries['card.json'];
  if (!cardEntry) throw new Error('卡片包缺少 card.json');
  const json = parseCardJson(strFromU8(cardEntry));

  const texts: PackageTextFile[] = [];
  const assets: PackageAsset[] = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path === 'card.json' || path.endsWith('/')) continue;
    const mime = guessMime(path);
    if (mime === 'application/octet-stream') texts.push({ path, text: strFromU8(data) });
    else assets.push({ path, mime, bytes: data });
  }
  return { json, texts, assets };
}

export function findText(pkg: CardPackage, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return pkg.texts.find((f) => f.path === path)?.text;
}
