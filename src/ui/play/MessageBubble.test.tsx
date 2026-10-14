import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageBubble from './MessageBubble';

const noop = () => undefined;

describe('訊息氣泡', () => {
  it('沒有任何標籤的純文字也要看得見（回歸：以前是空氣泡）', () => {
    render(<MessageBubble role="assistant" raw={'她抬起头看了你一眼。\n然后什么也没说。'} showOptions={false} onOption={noop} />);
    expect(screen.getByText(/她抬起头看了你一眼/)).toBeTruthy();
    // 換行要保留（white-space: pre-wrap）
    const node = screen.getByText(/她抬起头看了你一眼/);
    expect(node.className).toContain('whitespace-pre-wrap');
  });

  it('記憶區塊會顯示成可折疊的區塊，不會被吃掉', () => {
    const raw = [
      '<plot>正文段落</plot>',
      '<details><summary>近期记忆</summary>当前记忆数目：1/6<br>[1]（2026-10-13 傍晚）她拆穿了偷窥者。</details>',
    ].join('\n');
    render(<MessageBubble role="assistant" raw={raw} showOptions={false} onOption={noop} />);
    expect(screen.getByText('近期记忆')).toBeTruthy();
    expect(screen.getByText(/正文段落/)).toBeTruthy();
  });

  it('氣泡裡不會出現 <button> 包 <button> 的非法巢狀（折疊鈕要在氣泡內）', () => {
    const raw = '<details><summary>📅状况</summary>世界：现代都市</details>\n<plot>正文</plot>';
    const { container } = render(
      <MessageBubble role="assistant" raw={raw} showOptions onOption={noop} />,
    );
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
  });
});
