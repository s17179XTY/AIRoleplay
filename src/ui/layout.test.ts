import { describe, it, expect } from 'vitest';
import cssText from '../index.css?inline';

const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * 这一组测试是给「某些页面莫名其妙变窄」立的规矩。
 * 起因：曾经给应用外壳加过 max-width: 430px 的"手机壳"，
 * 于是在宽一点的窗口里内容只占一列、两旁留灰边，看起来就是"变窄了"。
 *
 * 2026-10-14 使用者改需求：**桌机想看到手机比例**（不要铺满整个浏览器）。
 * 所以现在的规矩是分层的：
 *   - 基础规则：外壳铺满可用宽高，不得有 max-width（手机上就是全屏）
 *   - 宽萤幕（>= 480px）媒体查询里：才允许收成 430px 并置中
 * 这样手机行为不变，桌机看到手机比例，而且「宽度类问题」仍然被测试拦住。
 */
describe('手机端布局约束', () => {
  it('基础规则：外壳铺满可用宽高，不得有 max-width', () => {
    expect(cssText.length).toBeGreaterThan(100);
    const shell = /\.dsh-shell\s*\{([\s\S]*?)\}/.exec(cssText)?.[1] ?? '';
    expect(shell).not.toBe('');
    expect(shell).toContain('width: 100%');
    expect(shell).toContain('100dvh');
    expect(shell).not.toMatch(/max-width/);
  });

  it('宽萤幕才收成手机宽度：媒体查询门坎 >= 480px 且里面有 max-width', () => {
    const media = /@media\s*\(min-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(cssText);
    expect(media, '宽萤幕媒体查询不见了——桌机又会铺满整个浏览器').toBeTruthy();
    const minWidth = Number(media![1]);
    expect(minWidth).toBeGreaterThanOrEqual(480);
    expect(media![2]).toMatch(/\.dsh-shell\s*\{[^}]*max-width:\s*430px/);
    expect(media![2]).toMatch(/margin-inline:\s*auto|margin:\s*0\s+auto/);
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
