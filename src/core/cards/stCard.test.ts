import { describe, it, expect } from 'vitest';
import { crc32, decodeCardText, encodeCardText, exportStPng, importStPng, readPngTextChunks, writePngTextChunks } from './stCard';
import type { CardPackage } from './package';

function buildBlankPng(): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  const view = new DataView(ihdrData.buffer);
  view.setUint32(0, 2);
  view.setUint32(4, 2);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const makeChunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = makeChunk('IHDR', ihdrData);
  const iend = makeChunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(sig.length + ihdr.length + iend.length);
  out.set(sig, 0);
  out.set(ihdr, sig.length);
  out.set(iend, sig.length + ihdr.length);
  return out;
}

const ST_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  name: '测试角色',
  description: '角色设定正文',
  personality: '外冷内热',
  scenario: '雨夜的便利店',
  first_mes: '她抬头看了你一眼。',
  mes_example: '<START>你好',
  system_prompt: '你是测试角色',
  post_history_instructions: '保持人设',
  tags: ['测试'],
  character_book: {
    entries: [
      { keys: ['便利店'], content: '二十四小时营业', insertion_order: 3, position: 'before_char', extensions: { depth: 2 } },
    ],
  },
};

describe('酒馆 PNG 卡', () => {
  it('base64 往返支持中文', () => {
    expect(decodeCardText(encodeCardText('中文测试'))).toBe('中文测试');
  });

  it('tEXt 块写入与读取', () => {
    const png = writePngTextChunks(buildBlankPng(), { chara: 'abc' }, ['chara']);
    expect(readPngTextChunks(png).chara).toBe('abc');
    const rewritten = writePngTextChunks(png, { chara: 'xyz' }, ['chara']);
    const all = readPngTextChunks(rewritten);
    expect(all.chara).toBe('xyz');
    expect(Object.keys(all)).toHaveLength(1);
  });

  it('导入酒馆卡把字段映射到自有结构', () => {
    const png = writePngTextChunks(buildBlankPng(), { chara: encodeCardText(JSON.stringify(ST_CARD)) }, ['chara']);
    const pkg = importStPng(png);
    expect(pkg.json.name).toBe('测试角色');
    expect(pkg.json.prompts.prompt).toBe('你是测试角色');
    expect(pkg.json.prompts.post).toBe('保持人设');
    expect(pkg.json.persona.intro).toBe('外冷内热');
    expect(pkg.json.firstMessage).toBe('她抬头看了你一眼。');
    const wb = JSON.parse(pkg.texts[0].text).entries;
    expect(wb[0].keys).toEqual(['便利店']);
    expect(wb[0].depth).toBe(2);
    expect(pkg.assets[0].mime).toBe('image/png');
  });

  it('导出后再导入字段保留', () => {
    const png = writePngTextChunks(buildBlankPng(), { chara: encodeCardText(JSON.stringify(ST_CARD)) }, ['chara']);
    const pkg: CardPackage = importStPng(png);
    const out = exportStPng(pkg);
    const back = importStPng(out);
    expect(back.json.name).toBe('测试角色');
    expect(back.json.scenario).toBe('雨夜的便利店');
  });

  it('没有角色数据的 PNG 给出明确错误', () => {
    expect(() => importStPng(buildBlankPng())).toThrow(/角色卡数据/);
  });
});
