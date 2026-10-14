import { describe, it, expect, beforeEach } from 'vitest';
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

describe('游玩页', () => {
  it('渲染开场白并可发送一条消息，回复中出现可点选项', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    expect(screen.getByText(/卡片互动页/)).toBeTruthy();
    expect(screen.getAllByText(/寻找新XP/).length).toBeGreaterThan(0);
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
