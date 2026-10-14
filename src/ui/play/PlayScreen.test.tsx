import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlayScreen from './PlayScreen';
import { db } from '../../core/storage/db';
import { createMockAdapter, mockReplyFor } from '../../core/providers/mock';
import { setAdapter, useSession } from '../../state/useSession';

beforeEach(async () => {
  await db.messages.clear();
  await db.chats.clear();
  await db.cards.clear();
  useSession.setState({
    ready: false, cardName: '', chatId: null, messages: [], draft: '', streaming: false, error: null,
  });
  setAdapter(createMockAdapter(mockReplyFor('测试', '演示卡'), { chunkSize: 500, delayMs: 0 }));
});

afterEach(async () => {
  // 点选项会在后台再发一轮；必须等它跑完再结束用例，
  // 否则 jsdom 环境销毁后流式回调仍会执行（曾报 "DOMParser is not defined" 未处理拒绝，把 vitest 退出码拖成 1）。
  await waitFor(() => expect(useSession.getState().streaming).toBe(false));
});

describe('游玩页', () => {
  it('渲染开场白并可发送一条消息，回复中出现可点选项', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    // 卡片打开时，互动页占满聊天框
    expect(document.querySelector('iframe')).toBeTruthy();
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText(/逼近一步/)).toBeTruthy());
  });

  it('点选项会把选项文本作为下一轮输入发出', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText(/逼近一步/)).toBeTruthy());
    fireEvent.click(screen.getByText(/逼近一步/));
    await waitFor(() => expect(screen.getByText(/A\. 逼近一步/)).toBeTruthy());
  });
});
