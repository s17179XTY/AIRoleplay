import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import CardPagePanel from './CardPagePanel';
import { buildBridgeScript } from '../../core/cards/sandbox';
import { useNav } from '../../state/useNav';
import { seedPackage } from '../../core/storage/seedPackage';

beforeEach(() => {
  cleanup();
  useNav.setState({ tab: 'play', editingCardId: null, toast: null });
});

const post = (payload: Record<string, unknown>) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { __dsh: true, ...payload } }));
  });
};

describe('聊天框内的卡片互动页', () => {
  it('渲染出沙箱 iframe（allow-scripts，不给 same-origin）', () => {
    const pkg = seedPackage();
    const html = pkg.texts.find((t) => t.path === 'ui/index.html')!.text;
    render(<CardPagePanel html={html} title="测试卡" />);
    const frame = document.querySelector('iframe');
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame!.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(screen.getByText(/卡片互动页/)).toBeTruthy();
  });

  it('页面里点复制后，平台接管写入剪贴板并提示粘贴发送', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const pkg = seedPackage();
    const html = pkg.texts.find((t) => t.path === 'ui/index.html')!.text;
    render(<CardPagePanel html={html} title="测试卡" />);

    post({ type: 'dsh:copy', payload: { text: '【初始信息设定】\n【全局XP】\nA1. 现实世界: ...' } });
    await act(async () => { await Promise.resolve(); });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('【初始信息设定】');
    expect(useNav.getState().toast).toContain('粘贴到下方输入框发送');
  });

  it('页面里的 alert 兜底会变成平台提示', () => {
    const pkg = seedPackage();
    const html = pkg.texts.find((t) => t.path === 'ui/index.html')!.text;
    render(<CardPagePanel html={html} title="测试卡" />);
    post({ type: 'dsh:toast', payload: { text: '复制失败，请手动复制' } });
    expect(useNav.getState().toast).toBe('复制失败，请手动复制');
  });

  it('桥脚本里包含复制接管与兜底 alert', () => {
    const bridge = buildBridgeScript();
    expect(bridge).toContain('dsh:copy');
    expect(bridge).toContain('generated-content-preview');
    expect(bridge).toContain('__htmlFixerInlineAlert');
  });
});
