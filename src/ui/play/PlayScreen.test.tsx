import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PlayScreen from './PlayScreen';
import { db } from '../../core/storage/db';
import { createMockAdapter, mockReplyFor } from '../../core/providers/mock';
import { setAdapter, useSession } from '../../state/useSession';
import type { ProviderAdapter, StreamEvent } from '../../core/providers/types';

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** 等使用者按「停止」才結束的假模型；firstChunk 為空字串代表一個字都還沒吐 */
function hangingAdapter(firstChunk: string): ProviderAdapter {
  return {
    id: 'mock',
    async listModels() {
      return [];
    },
    async *streamChat(_cfg, req): AsyncGenerator<StreamEvent> {
      if (firstChunk) yield { type: 'text', delta: firstChunk };
      await new Promise<void>((_resolve, reject) => {
        if (req.signal?.aborted) {
          reject(abortError());
          return;
        }
        req.signal?.addEventListener('abort', () => reject(abortError()));
      });
    },
  };
}

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
  // 點選項會在後台再發一輪；先確定沒有任何殘留的生成，
  // 否則 jsdom 環境銷毀後串流回呼仍會執行（曾報 "DOMParser is not defined" 未處理拒絕，把 vitest 退出碼拖成 1）。
  useSession.getState().stop();
  try {
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));
  } catch {
    // 用例本身已經失敗了，不要在 afterEach 再噴一次
  }
  // 一定要 unmount：少了這步，下一個用例會在多份 DOM 裡 getBy*，變成「找到多個元素」
  cleanup();
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

  it('等待吐字时显示提示，并且可以把生成停下來', async () => {
    setAdapter(hangingAdapter(''));
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));

    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));

    // 一個字都還沒吐：要有「正在等模型吐字」的提示，而不是一片空白
    await waitFor(() => expect(screen.getByTestId('waiting-hint')).toBeTruthy());
    // 而且發送鈕要換成停止鈕
    expect(screen.getByTestId('composer-stop')).toBeTruthy();

    fireEvent.click(screen.getByTestId('composer-stop'));
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));
    expect(screen.queryByTestId('waiting-hint')).toBeNull();
  });

  it('生成中按停止：已吐出的部分留在畫面上，也不顯示錯誤', async () => {
    setAdapter(hangingAdapter('已經吐出來的一段'));
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));

    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(useSession.getState().draft).toBe('已經吐出來的一段'));

    fireEvent.click(screen.getByTestId('composer-stop'));
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));

    await waitFor(() => expect(screen.getByText('已經吐出來的一段')).toBeTruthy());
    expect(useSession.getState().error).toBeNull();
  });
});
