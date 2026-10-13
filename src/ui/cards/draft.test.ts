import { describe, it, expect } from 'vitest';
import { draftToPackage, newRegexScript, newWorldbookEntry, packageToDraft } from './draft';
import { packCard, unpackCard } from '../../core/cards/package';
import { seedPackage } from '../../core/storage/seedPackage';

describe('卡片草稿', () => {
  it('包 → 草稿 → 包 往返保留世界书与界面', () => {
    const base = seedPackage();
    const draft = packageToDraft(base);
    expect(draft.worldbook.length).toBeGreaterThan(0);
    expect(draft.uiHtml).toContain('data-dsh-field');
    draft.worldbook.push(newWorldbookEntry(99));
    draft.regex.push(newRegexScript(0));
    draft.json.prompts.pre = '改过的前置词';
    const back = draftToPackage(draft, base);
    const reread = packageToDraft(back);
    expect(reread.json.prompts.pre).toBe('改过的前置词');
    expect(reread.worldbook).toHaveLength(draft.worldbook.length);
    expect(reread.regex).toHaveLength(1);
    expect(reread.uiHtml).toContain('data-dsh-field');
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
