import { describe, it, expect } from 'vitest';
import {
  ALLOWED_IMAGE_MIMES, IMAGE_MAX_BYTES, assertUploadableImage, isSvgLike, sniffImageMime,
} from './image';

const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const gif = () => new TextEncoder().encode('GIF89a' + 'x'.repeat(16));
const webp = () => new TextEncoder().encode('RIFF' + '....' + 'WEBP' + 'xxxx');
const html = () => new TextEncoder().encode('<html><script>alert(1)</script></html>');

describe('图片校验（真正的防护在这里，不是账号门槛）', () => {
  it('认得 PNG / JPEG / GIF / WebP 的文件头', () => {
    expect(sniffImageMime(png())).toBe('image/png');
    expect(sniffImageMime(jpeg())).toBe('image/jpeg');
    expect(sniffImageMime(gif())).toBe('image/gif');
    expect(sniffImageMime(webp())).toBe('image/webp');
  });

  it('伪装成 .png 的 HTML 会被挡下（只看文件头，不信副檔名）', () => {
    expect(sniffImageMime(html())).toBeNull();
    expect(() => assertUploadableImage(html())).toThrow(/不是图片/);
  });

  it('SVG 一律拒绝（它可以带脚本）', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(isSvgLike(svg)).toBe(true);
    expect(() => assertUploadableImage(svg)).toThrow(/SVG/);
  });

  it('超过 2 MB 直接拒绝', () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(png().subarray(0, 8), 0);
    expect(() => assertUploadableImage(big)).toThrow(/太大/);
  });

  it('空文件拒绝', () => {
    expect(() => assertUploadableImage(new Uint8Array(0))).toThrow(/空的/);
  });

  it('合法的 PNG 通过并回传推断出来的 mime', () => {
    expect(assertUploadableImage(png())).toBe('image/png');
  });

  it('白名单只有四种，不含 svg', () => {
    expect([...ALLOWED_IMAGE_MIMES]).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    expect((ALLOWED_IMAGE_MIMES as readonly string[]).includes('image/svg+xml')).toBe(false);
  });
});
