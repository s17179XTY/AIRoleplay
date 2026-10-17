import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PlayScreen from './PlayScreen';
import { db } from '../../core/storage/db';
import { createMockAdapter, mockReplyFor } from '../../core/providers/mock';
import { setAdapter, useSession } from '../../state/useSession';
import type { ProviderAdapter, StreamEvent } from '../../core/providers/types';
import { useComposer } from '../../state/useComposer';

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
  useComposer.setState({ texts: {} });
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

  it('顶栏只显示模型；上下文占用是输入框旁边的图标按钮，点开才看明细', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));

    // 顶栏不再塞上下文文字（以前会被挤到「文字被吞」）
    expect(screen.queryByTestId('context-hud')).toBeNull();
    expect(screen.getByText('mock 模拟模型')).toBeTruthy();

    // 图标按钮在输入框和发送键中间
    await waitFor(() => expect(screen.getByTestId('context-button')).toBeTruthy());
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    const btn = screen.getByTestId('context-button');
    expect(box.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('context-button').textContent).toMatch(/^\d+$/);

    fireEvent.click(screen.getByTestId('context-button'));
    await waitFor(() => expect(screen.getByText('上下文占用')).toBeTruthy());
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getByText('合计')).toBeTruthy();
  });

  it('四个入口收成一个菜单，按下才显示', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    expect(screen.queryByTestId('play-menu-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('play-menu'));
    await waitFor(() => expect(screen.getByTestId('play-menu-panel')).toBeTruthy());
    expect(screen.getByTestId('play-menu-panel').textContent).toContain('记忆');
  });

  it('滚动浮钮：往下滚显示「回到底部」、往上滚换成「回到顶部」，到顶/到底淡出', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    // 等真的有一则讯息落地（否则互动页还占着聊天区，找不到滚动容器）
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));
    await waitFor(() => expect(useSession.getState().messages.length).toBeGreaterThan(0));

    const el = screen.getByTestId('message-scroll');
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });

    // 一开始在最上面：不显示
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
    expect(screen.queryByTestId('scroll-to-top')).toBeNull();

    // 往下滚（0 → 500）：显示「回到底部」
    el.scrollTop = 500;
    fireEvent.scroll(el);
    await waitFor(() => expect(screen.getByTestId('scroll-to-bottom')).toBeTruthy());
    // 图标按钮里没有文字（使用者要求：不要弄成文字）
    expect(screen.getByTestId('scroll-to-bottom').textContent).toBe('');

    // 往上滚（500 → 100）：换成「回到顶部」
    el.scrollTop = 100;
    fireEvent.scroll(el);
    await waitFor(() => expect(screen.getByTestId('scroll-to-top')).toBeTruthy());
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();

    // 回到最底部：淡出
    el.scrollTop = 1600;
    fireEvent.scroll(el);
    await waitFor(() => expect(screen.queryByTestId('scroll-to-top')).toBeNull());
  });

  it('右上角 + 按钮新开一个对话', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(useSession.getState().messages.length).toBe(2));
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));
    const before = useSession.getState().chatId;

    fireEvent.click(screen.getByTestId('play-new-chat'));
    await waitFor(() => expect(useSession.getState().chatId).not.toBe(before));
    await waitFor(() => expect(useSession.getState().messages.length).toBe(0));
  });

  it('输入框草稿：切到别的页面（组件卸载）再回来还在', async () => {
    const first = render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    fireEvent.change(screen.getByPlaceholderText('开始你的第一次 AI 聊天吧'), { target: { value: '打到一半的话' } });
    first.unmount();

    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧') as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('打到一半的话'));
  });

  it('对话列表用右侧图标按钮：改名与删除都不再占一行', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));
    // 入口收进菜单里了，先进菜单再点「对话」
    fireEvent.click(screen.getByTestId('play-menu'));
    await waitFor(() => expect(screen.getByTestId('play-menu-panel')).toBeTruthy());
    fireEvent.click(screen.getByText('对话'));
    await waitFor(() => expect(screen.getByText('对话列表')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByLabelText(/^改名/).length).toBeGreaterThan(0));
    expect(screen.getAllByLabelText(/^删除/).length).toBeGreaterThan(0);
  });

  it('生成期间输入框与发送键一起锁住，只留「停止」', async () => {
    setAdapter(hangingAdapter(''));
    render(<PlayScreen />);
    await waitFor(() => expect(useSession.getState().ready).toBe(true));

    const box = screen.getByPlaceholderText('开始你的第一次 AI 聊天吧');
    fireEvent.change(box, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(useSession.getState().streaming).toBe(true));

    // 严格一对：生成中不能打字、也不能再发一条
    await waitFor(() => expect(screen.getByPlaceholderText('AI 正在回复…').hasAttribute('disabled')).toBe(true));
    expect(screen.queryByText('发送')).toBeNull();
    fireEvent.click(screen.getByTestId('composer-stop'));
    await waitFor(() => expect(useSession.getState().streaming).toBe(false));
  });
});