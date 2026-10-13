import { describe, it, expect } from 'vitest';
import { seedPackage } from './seedPackage';
import { packCard, unpackCard } from '../cards/package';
import { parseWorldbookFile } from '../cards/spec';

describe('演示卡包', () => {
  it('打成 zip 再解包结构完整', () => {
    const pkg = seedPackage();
    const back = unpackCard(packCard(pkg));
    expect(back.json.name).toContain('演示卡');
    expect(back.texts.map((t) => t.path).sort()).toEqual(['prompt.template.md', 'ui/index.html', 'worldbook.json']);
    expect(back.assets).toHaveLength(1);
  });

  it('世界书与界面可从包中解析', () => {
    const pkg = seedPackage();
    const entries = parseWorldbookFile(pkg.texts.find((t) => t.path === 'worldbook.json')!.text);
    expect(entries.length).toBeGreaterThan(0);
    expect(pkg.texts.find((t) => t.path === 'ui/index.html')!.text).toContain('data-dsh-field');
  });
});
