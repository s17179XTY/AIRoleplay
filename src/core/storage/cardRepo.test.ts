import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { deleteCard, ensureSeedCard, listCards, loadCardPackage, saveCardPackage, worldbookOf } from './cardRepo';
import { DEMO_CARD_ID } from './seed';
import { parseCardJson, serializeCardJson, CARD_SPEC, emptyCardJson } from '../cards/spec';
import { packCard, unpackCard } from '../cards/package';

const mkPkg = () => {
  const json = emptyCardJson('测试卡');
  json.id = 'card-test-1';
  json.prompts.prompt = '系统提示词';
  json.worldbook = 'worldbook.json';
  json.ui = { entry: 'ui/index.html', autoOpen: true };
  return {
    json,
    texts: [
      { path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: [{ id: 'w1', keys: ['甲'], content: '世界书内容' }] }) },
      { path: 'ui/index.html', text: '<h1>界面</h1>' },
    ],
    assets: [{ path: 'assets/cover.png', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }],
  };
};

beforeEach(async () => {
  await db.cardFiles.clear();
  await db.cards.clear();
  await db.assets.clear();
});

describe('卡片清单', () => {
  it('spec 校验与默认值补齐', () => {
    const json = parseCardJson(JSON.stringify({ spec: CARD_SPEC, name: '甲' }));
    expect(json.memory.recentLimit).toBe(6);
    expect(json.prompts.prompt).toBe('');
    expect(() => parseCardJson('{"spec":"other/9"}')).toThrow();
    expect(() => parseCardJson('not json')).toThrow();
  });

  it('序列化后仍可解析', () => {
    const j = emptyCardJson('乙');
    expect(parseCardJson(serializeCardJson(j)).name).toBe('乙');
  });
});

describe('卡片包 zip', () => {
  it('打包再解包内容一致', () => {
    const pkg = mkPkg();
    const bytes = packCard(pkg);
    const back = unpackCard(bytes);
    expect(back.json.name).toBe('测试卡');
    expect(back.texts.find((t) => t.path === 'ui/index.html')?.text).toBe('<h1>界面</h1>');
    expect(back.assets.find((a) => a.path === 'assets/cover.png')?.bytes.length).toBe(4);
  });

  it('缺少 card.json 时给出明确错误', () => {
    expect(() => unpackCard(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('卡片仓库', () => {
  it('保存后可读回，世界书可解析', async () => {
    const id = await saveCardPackage(mkPkg());
    const loaded = await loadCardPackage(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.json.prompts.prompt).toBe('系统提示词');
    expect(worldbookOf(loaded!)[0].content).toBe('世界书内容');
    expect(loaded!.assets[0].mime).toBe('image/png');
    expect((await listCards()).length).toBe(1);
  });

  it('旧版本遗留的坏卡片（只有卡片行没有 card.json）会被自动修复', async () => {
    await db.cards.add({
      id: DEMO_CARD_ID, name: '坏卡', author: '内置示例', version: '1.0.0', description: '',
      tags: [], source: 'local', spec: CARD_SPEC, createdAt: 1, updatedAt: 1,
    });
    expect(await loadCardPackage(DEMO_CARD_ID)).toBeNull();
    const id = await ensureSeedCard();
    expect(id).toBe(DEMO_CARD_ID);
    const repaired = await loadCardPackage(id);
    expect(repaired).not.toBeNull();
    expect(repaired!.texts.find((t) => t.path === 'ui/index.html')?.text).toContain('generated-content-preview');
  });

  it('删除卡片会清掉文件与素材', async () => {
    const id = await saveCardPackage(mkPkg());
    await deleteCard(id);
    expect(await db.cardFiles.where('cardId').equals(id).count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
  });
});

describe('卡片头像与封面引用', () => {
  const AVATAR = 'assets/avatar.png';
  const COVER = 'assets/cover.png';

  /** 一张带头像 + 封面的卡 */
  const withImages = () => {
    const pkg = mkPkg();
    pkg.json.cover = COVER;
    pkg.json.avatar = AVATAR;
    pkg.assets.push({ path: AVATAR, mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) });
    return pkg;
  };

  /** 模拟「card.json 里的图片字段被清掉」（旧编辑器 / 别的装置写回来的卡） */
  const clearImageFields = async (id: string) => {
    const row = await db.cardFiles.get([id, 'card.json']);
    const json = JSON.parse(row!.text!) as Record<string, unknown>;
    delete json.cover;
    delete json.avatar;
    await db.cardFiles.put({ ...row!, text: JSON.stringify(json) });
  };

  it('保存时会记下头像：json.avatar、assets、record.avatarAssetId 都对得上', async () => {
    const id = await saveCardPackage(withImages());

    const record = await db.cards.get(id);
    expect(record!.avatarAssetId).toBe(id + ':' + AVATAR);
    expect(record!.coverAssetId).toBe(id + ':' + COVER);

    const loaded = await loadCardPackage(id);
    expect(loaded!.json.avatar).toBe(AVATAR);
    expect(loaded!.assets.find((a) => a.path === AVATAR)?.bytes.byteLength).toBe(7);
  });

  it('record 有 avatarAssetId 但 card.json 的字段被清掉 → load 用 record 回填', async () => {
    const id = await saveCardPackage(withImages());
    await clearImageFields(id);

    const loaded = await loadCardPackage(id);
    expect(loaded!.json.avatar).toBe(AVATAR);
    expect(loaded!.json.cover).toBe(COVER);
    // 回填只给界面解析用，不该把数据库里的 card.json 改掉
    const row = await db.cardFiles.get([id, 'card.json']);
    expect((JSON.parse(row!.text!) as Record<string, unknown>).avatar).toBeUndefined();
  });

  it('重存一份不含图片字节的包（导出后再导入）不会把头像引用弄丢', async () => {
    const pkg = withImages();
    const id = await saveCardPackage(pkg);

    const noAssets = unpackCard(packCard(pkg, { includeAssets: false }));
    expect(noAssets.assets).toHaveLength(0);
    noAssets.json.id = id;
    await saveCardPackage(noAssets);

    const record = await db.cards.get(id);
    expect(record!.avatarAssetId).toBe(id + ':' + AVATAR);
    expect(record!.coverAssetId).toBe(id + ':' + COVER);
  });
});
