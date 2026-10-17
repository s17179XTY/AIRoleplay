import type { CardPackage, PackageAsset } from '../../core/cards/package';

/** 路径的最后一段；`assets/avatar.png` → `avatar.png` */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * 在卡片包里找一张图。
 *
 * 先按 path 全等找；找不到再退回「同名文件」——导入的卡（别人打的 zip）
 * 常把 `assets/avatar.png` 写成 `avatar.png` 或 `img/AVATAR.png`，
 * card.json 里的路径与真实文件名对不上时，界面就整张图都不见了。
 */
export function findCardAsset(
  pkg: CardPackage | null | undefined,
  targetPath: string | null | undefined,
): PackageAsset | undefined {
  if (!pkg || !targetPath) return undefined;
  const exact = pkg.assets.find((a) => a.path === targetPath);
  if (exact) return exact;

  const base = baseName(targetPath);
  if (!base) return undefined;
  const sameName = pkg.assets.find((a) => baseName(a.path) === base);
  if (sameName) return sameName;

  // 大小写也放宽：Windows / 手机相册导出的文件名大小写经常不一样
  const lower = base.toLowerCase();
  return pkg.assets.find((a) => baseName(a.path).toLowerCase() === lower);
}

/**
 * 界面真正要显示的两张图：封面 + 聊天头像。
 *
 * **头像没有就回退用封面**——使用者的期望是「卡片有图，聊天气泡旁边就该看到这张图」，
 * 当初是传进「封面」还是「头像」槽位不该影响显示。
 */
export function resolveCardImages(
  pkg: CardPackage | null | undefined,
): { cover?: PackageAsset; avatar?: PackageAsset } {
  if (!pkg) return {};
  const cover = findCardAsset(pkg, pkg.json.cover);
  const avatar = findCardAsset(pkg, pkg.json.avatar) ?? cover;
  return { cover, avatar };
}
