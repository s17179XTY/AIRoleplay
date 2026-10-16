/**
 * 图片上传的校验与压缩。
 *
 * 真正的防护在这里，**不是**「要有账号才能上传」那条产品门槛（谁都能注册）。
 * 三条硬规则：
 * 1. **magic byte 白名单**：只看文件头，不信副檔名（把 HTML 改名成 .png 会被挡下）。
 * 2. **不接受 SVG**：SVG 可以带脚本，inline 渲染就等于把 XSS 请进来。
 * 3. **体积与边长上限**：挡解压炸弹与超大文件。
 */

export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

/** 原文件体积上限（压缩前）。手机照片动辄 3–8 MB，卡太小会让人以为「上传不了」 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 最长边上限（防解压炸弹） */
export const IMAGE_MAX_EDGE = 4096;
/** 压缩后的目标边长 */
export const COVER_MAX_EDGE = 512;
export const AVATAR_MAX_EDGE = 128;

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...Array.from(bytes.subarray(start, start + len)));
}

/** 只看文件头判断真实类型；认不出来就回 null（= 拒绝） */
export function sniffImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

export function isSvgLike(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, Math.min(bytes.length, 256)).toLowerCase();
  return head.includes('<svg') || head.includes('<?xml');
}

/** 校验；不合法就抛错（错误讯息直接给使用者看） */
export function assertUploadableImage(bytes: Uint8Array): AllowedImageMime {
  if (bytes.byteLength === 0) throw new Error('这个文件是空的');
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(`图片太大了（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB），请压到 10 MB 以内`);
  }
  if (isSvgLike(bytes)) throw new Error('不支持 SVG（它可以带脚本），请用 PNG / JPEG / WebP / GIF');
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error('这看起来不是图片（只接受 PNG / JPEG / WebP / GIF）');
  return mime;
}

export interface CompressedImage {
  bytes: Uint8Array;
  mime: AllowedImageMime;
  width: number;
  height: number;
}

function maxEdgeOf(bytes: Uint8Array, mime: AllowedImageMime): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败，可能已损坏'));
    };
    img.src = url;
  });
}

/**
 * 压到指定最长边再存（封面 512 / 头像 128）。
 * 浏览器没有 canvas 能力时（例如测试环境）退化成「原样存」—— 体积已经在前面校验过了。
 */
export async function compressImage(
  bytes: Uint8Array,
  mime: AllowedImageMime,
  maxEdge: number,
): Promise<CompressedImage> {
  const { width, height } = await maxEdgeOf(bytes, mime);
  if (width > IMAGE_MAX_EDGE || height > IMAGE_MAX_EDGE) {
    throw new Error(`图片尺寸太大（${width}×${height}），最长边请压到 ${IMAGE_MAX_EDGE} 以内`);
  }
  if (typeof document === 'undefined' || width <= maxEdge && height <= maxEdge === false) {
    return { bytes, mime, width, height };
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { bytes, mime, width, height };

  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    ctx.drawImage(img, 0, 0, targetW, targetH);
    const outMime: AllowedImageMime = mime === 'image/gif' ? 'image/png' : mime;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outMime, 0.9));
    if (!blob) return { bytes, mime, width, height };
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { bytes: buf, mime: outMime, width: targetW, height: targetH };
  } finally {
    URL.revokeObjectURL(url);
  }
}
