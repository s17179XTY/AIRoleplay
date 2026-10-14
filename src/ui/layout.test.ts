import { describe, it, expect } from 'vitest';
import cssText from '../index.css?inline';

const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * 这一组测试是给「某些页面莫名其妙变窄」立的规矩。
 * 起因：曾经给应用外壳加过 max-width: 430px 的"手机壳"，
 * 于是在宽一点的窗口里内容只占一列、两旁留灰边，看起来就是"变窄了"。
 * 只做手机端 = 单一纵列 + 铺满可用宽高，不做固定宽度容器。
 */
describe('手机端布局约束', () => {
  it('样式表里能找到外壳规则，且没有固定宽度', () => {
    expect(cssText.length).toBeGreaterThan(100);
    const shell = /\.dsh-shell\s*\{([\s\S]*?)\}/.exec(cssText)?.[1] ?? '';
    expect(shell).not.toBe('');
    expect(shell).toContain('width: 100%');
    expect(shell).toContain('100dvh');
    expect(shell).not.toMatch(/max-width/);
  });

  it('页面本身不滚动、滚动条不占位（否则内容会被挤窄）', () => {
    expect(cssText).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
    expect(cssText).toContain('scrollbar-width: none');
    expect(cssText).toContain('::-webkit-scrollbar');
  });

  it('界面代码里没有写死像素宽的容器', () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      const hits = src.match(/max-w-\[\d+px\]|w-\[\d{3,}px\]/g);
      if (hits) offenders.push(path + ' → ' + hits.join(', '));
    }
    expect(offenders).toEqual([]);
  });

  it('正文字号走 CSS 变量，方便全局缩放', () => {
    expect(cssText).toContain('--dsh-fs');
    expect(cssText).toMatch(/\.dsh-bubble\s*\{[^}]*font-size:\s*var\(--dsh-fs\)/);
  });
});
