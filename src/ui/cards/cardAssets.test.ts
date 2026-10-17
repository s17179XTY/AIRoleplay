import { describe, it, expect } from 'vitest';
import { findCardAsset, resolveCardImages } from './cardAssets';
import { emptyCardJson } from '../../core/cards/spec';
import type { CardPackage, PackageAsset } from '../../core/cards/package';

const png = (path: string, tag = 1): PackageAsset => ({
  path, mime: 'image/png', bytes: new Uint8Array([tag]),
});

const mkPkg = (refs: { cover?: string; avatar?: string }, assets: PackageAsset[]): CardPackage => ({
  json: { ...emptyCardJson('测试卡'), ...refs },
  texts: [],
  assets,
});

describe('卡片图片解析', () => {
  it('path 全等优先（不能被同名文件抢走）', () => {
    const want = png('assets/avatar.png', 1);
    const other = png('other/avatar.png', 2);
    const pkg = mkPkg({ avatar: 'assets/avatar.png' }, [other, want]);
    expect(findCardAsset(pkg, 'assets/avatar.png')).toBe(want);
  });

  it('路径对不上时用 basename 兜底（导入的卡常见）', () => {
    const asset = png('img/AVATAR.png', 3);
    const pkg = mkPkg({ avatar: 'assets/avatar.png' }, [asset]);
    expect(findCardAsset(pkg, 'assets/avatar.png')).toBe(asset);
  });

  it('找不到就是 undefined，不要乱抓别的图', () => {
    const pkg = mkPkg({ avatar: 'assets/avatar.png' }, [png('assets/cover.png')]);
    expect(findCardAsset(pkg, 'assets/avatar.png')).toBeUndefined();
    expect(findCardAsset(pkg, undefined)).toBeUndefined();
    expect(findCardAsset(null, 'assets/avatar.png')).toBeUndefined();
  });

  it('头像没有时回退用封面（卡片有图，气泡旁就该看到这张图）', () => {
    const cover = png('assets/cover.png', 7);
    const pkg = mkPkg({ cover: 'assets/cover.png' }, [cover]);
    expect(resolveCardImages(pkg)).toEqual({ cover, avatar: cover });
  });

  it('头像存在就不回退', () => {
    const cover = png('assets/cover.png', 7);
    const avatar = png('assets/avatar.png', 8);
    const pkg = mkPkg({ cover: 'assets/cover.png', avatar: 'assets/avatar.png' }, [cover, avatar]);
    expect(resolveCardImages(pkg).avatar).toBe(avatar);
  });

  it('头像路径失效（包里的文件被删了）也回退封面', () => {
    const cover = png('assets/cover.png', 7);
    const pkg = mkPkg({ cover: 'assets/cover.png', avatar: 'assets/gone.png' }, [cover]);
    expect(resolveCardImages(pkg).avatar).toBe(cover);
  });

  it('一张图都没有时两张都空', () => {
    expect(resolveCardImages(mkPkg({}, []))).toEqual({ cover: undefined, avatar: undefined });
    expect(resolveCardImages(null)).toEqual({});
  });
});
