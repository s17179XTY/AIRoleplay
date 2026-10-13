import { emptyCardJson, CARD_SPEC, type DshCardJson } from './spec';
import type { CardPackage } from './package';
import type { WbEntryInput } from '../assembler/types';

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Chunk { type: string; data: Uint8Array; start: number; end: number; }

function readChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) break;
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd), start: offset, end });
    offset = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return PNG_SIG.every((b, i) => bytes[i] === b);
}

export function readPngTextChunks(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of readChunks(bytes)) {
    if (chunk.type !== 'tEXt') continue;
    const sep = chunk.data.indexOf(0);
    if (sep < 0) continue;
    const keyword = latin1(chunk.data.subarray(0, sep));
    const text = latin1(chunk.data.subarray(sep + 1));
    out[keyword] = text;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function textChunk(keyword: string, text: string): Uint8Array {
  const kw = latin1ToBytes(keyword);
  const value = latin1ToBytes(text);
  const data = new Uint8Array(kw.length + 1 + value.length);
  data.set(kw, 0);
  data[kw.length] = 0;
  data.set(value, kw.length + 1);
  return buildChunk('tEXt', data);
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function writePngTextChunks(bytes: Uint8Array, kv: Record<string, string>, replaceKeys: string[]): Uint8Array {
  const chunks = readChunks(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const drop = new Set(replaceKeys);
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const sep = chunk.data.indexOf(0);
      const keyword = sep > 0 ? latin1(chunk.data.subarray(0, sep)) : '';
      if (drop.has(keyword)) continue;
    }
    if (chunk.type === 'IEND') {
      for (const [keyword, text] of Object.entries(kv)) parts.push(textChunk(keyword, text));
    }
    parts.push(bytes.subarray(chunk.start, chunk.end));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeCardText(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function decodeCardText(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

interface StEntry {
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  enabled?: boolean;
  constant?: boolean;
  selective?: boolean;
  insertion_order?: number;
  position?: string;
  extensions?: { depth?: number; recursive?: boolean };
}

interface StCard {
  spec?: string;
  spec_version?: string;
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  tags?: string[];
  character_book?: { entries?: StEntry[] };
  data?: StCard;
}

export function importStPng(bytes: Uint8Array): CardPackage {
  if (!isPng(bytes)) throw new Error('不是 PNG 文件');
  const chunks = readPngTextChunks(bytes);
  const payload = chunks.ccv3 ?? chunks.chara;
  if (!payload) throw new Error('这张图里没有找到角色卡数据（可能图片被压缩或转码过，请用原始文件）');
  let parsed: StCard;
  try {
    parsed = JSON.parse(decodeCardText(payload)) as StCard;
  } catch {
    throw new Error('角色卡数据解析失败');
  }
  const st: StCard = parsed.data ?? parsed;

  const json: DshCardJson = emptyCardJson(st.name ?? '未命名角色卡');
  json.author = '';
  json.version = '1.0.0';
  json.description = st.description ?? '';
  json.tags = st.tags ?? [];
  json.prompts.pre = '';
  json.prompts.prompt = st.system_prompt ?? '';
  json.prompts.post = st.post_history_instructions ?? '';
  json.persona.intro = st.personality ?? '';
  json.scenario = st.scenario ?? '';
  json.firstMessage = st.first_mes ?? '';
  json.mesExample = st.mes_example ?? '';
  if (st.creator_notes) json.tags = [...json.tags, '酒馆导入'];

  const texts: CardPackage['texts'] = [];
  const entries = st.character_book?.entries ?? [];
  if (entries.length > 0) {
    const wbEntries: WbEntryInput[] = entries.map((e, i) => ({
      id: 'wb-' + i,
      keys: e.keys ?? [],
      secondaryKeys: e.secondary_keys ?? [],
      content: e.content ?? '',
      constant: Boolean(e.constant),
      selective: Boolean(e.selective),
      position: e.position === 'after_char' ? 'after-char' : 'before-char',
      order: typeof e.insertion_order === 'number' ? e.insertion_order : i,
      depth: e.extensions?.depth ?? 4,
      recursive: Boolean(e.extensions?.recursive),
      enabled: e.enabled === undefined ? true : Boolean(e.enabled),
    }));
    json.worldbook = 'worldbook.json';
    texts.push({ path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: wbEntries }, null, 2) });
  }

  return { json, texts, assets: [{ path: 'assets/cover.png', mime: 'image/png', bytes }] };
}

export function exportStPng(pkg: CardPackage): Uint8Array {
  const cover = pkg.assets.find((a) => a.path === pkg.json.cover) ?? pkg.assets.find((a) => a.mime === 'image/png');
  if (!cover) throw new Error('导出酒馆卡需要一张 PNG 封面（请在卡片里放一张封面图）');
  const entries = pkg.json.worldbook
    ? JSON.parse(pkg.texts.find((t) => t.path === pkg.json.worldbook)?.text ?? '{"entries":[]}').entries ?? []
    : [];
  const st = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: pkg.json.name,
    description: pkg.json.description,
    personality: pkg.json.persona.intro,
    scenario: pkg.json.scenario,
    first_mes: pkg.json.firstMessage,
    mes_example: pkg.json.mesExample,
    system_prompt: pkg.json.prompts.prompt,
    post_history_instructions: pkg.json.prompts.post,
    creator_notes: '由本地应用导出',
    tags: pkg.json.tags,
    character_book: {
      entries: entries.map((e: WbEntryInput, i: number) => ({
        keys: e.keys,
        secondary_keys: e.secondaryKeys,
        content: e.content,
        enabled: e.enabled,
        constant: e.constant,
        selective: e.selective,
        insertion_order: e.order ?? i,
        position: e.position === 'after-char' ? 'after_char' : 'before_char',
        extensions: { depth: e.depth, recursive: e.recursive },
      })),
    },
  };
  return writePngTextChunks(cover.bytes, { chara: encodeCardText(JSON.stringify(st)) }, ['chara', 'ccv3']);
}

export { CARD_SPEC };
