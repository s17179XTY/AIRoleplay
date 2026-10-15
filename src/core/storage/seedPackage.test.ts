import { describe, it, expect } from 'vitest';
import { seedPackage } from './seedPackage';
import { packCard, unpackCard } from '../cards/package';
import { parseWorldbookFile } from '../cards/spec';

describe('演示卡包', () => {
  it('打成 zip 再解包结构完整', () => {
    const pkg = seedPackage();
    const back = unpackCard(packCard(pkg));
    expect(back.json.name).toContain('寻找新XP');
    expect(back.texts.map((t) => t.path).sort()).toEqual(['ui/index.html', 'worldbook.json']);
    expect(back.assets).toHaveLength(1);
  });

  it('世界书为空文件，界面可从包中解析', () => {
    const pkg = seedPackage();
    const entries = parseWorldbookFile(pkg.texts.find((t) => t.path === 'worldbook.json')!.text);
    expect(entries).toHaveLength(0);
    expect(pkg.texts.find((t) => t.path === 'ui/index.html')!.text).toContain('generated-content-preview');
  });

  it('导出卡片默认可以不带图片（避免夹带文件／包太大）', () => {
    const pkg = seedPackage();
    expect(pkg.assets.length).toBeGreaterThan(0);

    expect(unpackCard(packCard(pkg)).assets).toHaveLength(pkg.assets.length);

    const without = unpackCard(packCard(pkg, { includeAssets: false }));
    expect(without.assets).toHaveLength(0);
    // 卡片本体（card.json 与互动页）还在
    expect(without.json.name).toBe(pkg.json.name);
    expect(without.texts.map((t) => t.path)).toContain('ui/index.html');
  });
});
