import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsScreen from './SettingsScreen';
import { db } from '../../core/storage/db';
import { getActive } from '../../core/storage/providerRepo';
import { useNav } from '../../state/useNav';

beforeEach(async () => {
  await db.providers.clear();
  await db.modelPresets.clear();
  await db.settings.clear();
  await db.configs.clear();
  useNav.setState({ tab: 'settings', editingCardId: null, toast: null });
});

describe('设置页', () => {
  it('添加服务商 → 新增模型配置 → 设为当前', async () => {
    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('模型接入')).toBeTruthy());

    fireEvent.click(screen.getByText('+ 添加服务商'));
    fireEvent.change(screen.getByPlaceholderText('服务商名称'), { target: { value: '我的中转' } });
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: 'https://api.example.com' } });
    fireEvent.change(screen.getByPlaceholderText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('保存服务商'));
    await waitFor(() => expect(screen.getByText('我的中转')).toBeTruthy());

    fireEvent.click(screen.getByText('+ 新增模型配置'));
    fireEvent.change(screen.getByPlaceholderText(/模型名/), { target: { value: 'deepseek-chat' } });
    fireEvent.click(screen.getByText('保存模型配置'));
    await waitFor(() => expect(screen.getByText('deepseek-chat')).toBeTruthy());

    fireEvent.click(screen.getByText('设为当前'));
    await waitFor(async () => {
      const active = await getActive();
      expect(active?.provider.label).toBe('我的中转');
      expect(active?.preset.model).toBe('deepseek-chat');
    });
  });

  it('全局配置可保存并读回', async () => {
    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('全局配置（对所有卡片生效）')).toBeTruthy());
    // 用 aria-label 定位，不要用「第 0 個 textbox」——上面多了帳號分節就會指錯欄位
    fireEvent.change(screen.getByLabelText('全局提示词'), { target: { value: '全局提示词内容' } });
    fireEvent.click(screen.getByText('保存全局配置'));
    await waitFor(async () => {
      const cfg = await db.configs.where('scope').equals('global').first();
      expect(cfg?.prompt).toBe('全局提示词内容');
    });
  });
});
