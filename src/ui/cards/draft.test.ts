import { describe, it, expect } from 'vitest';
import { draftToPackage, newRegexScript, newWorldbookEntry, packageToDraft } from './draft';
import { packCard, unpackCard } from '../../core/cards/package';
import { seedPackage } from '../../core/storage/seedPackage';
import type { CardPackage } from '../../core/cards/package';

/**
 * 內置卡的世界書刻意是空的（世界觀由互動頁決定），
 * 所以「世界書往返」的測試要自己塞一份進去，不能靠內置卡帶資料。
 */
function withWorldbook(base = seedPackage()): CardPackage {
  const file = base.texts.find((t) => t.path === 'worldbook.json');
  const entries = [
    {
      id: 'wb-test', keys: ['测试'], secondaryKeys: [], content: '测试条目',
      constant: false, selective: false, position: 'before-char' as const,
      order: 0, depth: 4, recursive: false, enabled: true,
    },
  ];
  const text = JSON.stringify({ version: 1, entries });
  if (file) file.text = text;
  else base.texts.push({ path: 'worldbook.json', text });
  base.json.worldbook = 'worldbook.json';
  return base;
}

describe('卡片草稿', () => {
  it('包 → 草稿 → 包 往返保留世界书与界面', () => {
    const base = withWorldbook();
    const draft = packageToDraft(base);
    expect(draft.worldbook).toHaveLength(1);
    expect(draft.uiHtml).toContain('generated-content-preview');
    draft.worldbook.push(newWorldbookEntry(99));
    draft.regex.push(newRegexScript(0));
    draft.json.prompts.pre = '改过的前置词';
    const back = draftToPackage(draft, base);
    const reread = packageToDraft(back);
    expect(reread.json.prompts.pre).toBe('改过的前置词');
    expect(reread.worldbook).toHaveLength(draft.worldbook.length);
    expect(reread.regex).toHaveLength(1);
    expect(reread.uiHtml).toContain('generated-content-preview');
  });

  it('清空世界书时不再写出 worldbook.json', () => {
    const base = seedPackage();
    const draft = packageToDraft(base);
    draft.worldbook = [];
    const back = draftToPackage(draft, base);
    expect(back.json.worldbook).toBeUndefined();
    expect(back.texts.find((t) => t.path === 'worldbook.json')).toBeUndefined();
  });

  it('往返后仍能打成 zip 并解包', () => {
    const base = seedPackage();
    const back = draftToPackage(packageToDraft(base), base);
    expect(unpackCard(packCard(back)).json.name).toBe(base.json.name);
  });
});
