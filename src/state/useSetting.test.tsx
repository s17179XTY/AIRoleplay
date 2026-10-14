import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { db } from '../core/storage/db';
import { resetSettingCache, useSetting, useSettingFlag } from './useSetting';

/**
 * 兩個獨立呼叫點讀同一個 key——這正是 AppShell（寫 --dsh-fs）與設定頁（那排字級按鈕）的關係。
 * 以前兩邊各有一份 useState，在設定頁點字級，AppShell 那份永遠不知道，
 * 使用者看到的就是「字級設定沒生效」。
 */
function TwoReaders() {
  const [a, setA] = useSetting('fontScale', '16');
  const [b, setB] = useSetting('fontScale', '16');
  return (
    <div>
      <span data-testid="a">{a}</span>
      <span data-testid="b">{b}</span>
      <button type="button" onClick={() => setA('20')}>改A</button>
      <button type="button" onClick={() => setB('14')}>改B</button>
    </div>
  );
}

function Flag() {
  const [on, setOn] = useSettingFlag('memoryEnabled', true);
  return (
    <div>
      <span data-testid="flag">{on ? 'on' : 'off'}</span>
      <button type="button" onClick={() => setOn(!on)}>切換</button>
    </div>
  );
}

beforeEach(async () => {
  await db.settings.clear();
  resetSettingCache();
});

describe('設定值的共享快取', () => {
  it('同一個 key 的所有訂閱者共享一份值，改一邊另一邊立刻跟上並落庫', async () => {
    render(<TwoReaders />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('16'));

    fireEvent.click(screen.getByText('改A'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('20'));
    await waitFor(async () => expect((await db.settings.get('fontScale'))?.value).toBe('20'));

    fireEvent.click(screen.getByText('改B'));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('14'));
  });

  it('resetSettingCache 之後重讀資料庫（換帳號庫 / 恢復預設會用到）', async () => {
    await db.settings.put({ key: 'fontScale', value: '18' });
    render(<TwoReaders />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('18'));

    // 模擬換庫：資料庫裡的值變成別的了
    await db.settings.put({ key: 'fontScale', value: '14' });
    await act(async () => {
      resetSettingCache();
    });
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('14'));
  });

  it('資料庫沒有這個 key 時用 fallback', async () => {
    render(<TwoReaders />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('16'));
    expect(await db.settings.get('fontScale')).toBeUndefined(); // 只是顯示預設，不會偷偷寫一筆
  });

  it('useSettingFlag 以 0/1 存取，預設值可指定', async () => {
    render(<Flag />);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('on'));

    fireEvent.click(screen.getByText('切換'));
    await waitFor(async () => expect((await db.settings.get('memoryEnabled'))?.value).toBe('0'));
    expect(screen.getByTestId('flag').textContent).toBe('off');
  });
});
