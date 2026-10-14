import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SettingsScreen from './SettingsScreen';
import { db } from '../../core/storage/db';
import { getActive, listProviders, savePreset, saveProvider, setActive } from '../../core/storage/providerRepo';
import { ensureSeedCard, loadCardPackage, saveCardPackage, worldbookOf } from '../../core/storage/cardRepo';
import { DEMO_CARD_ID } from '../../core/storage/seed';
import { useNav } from '../../state/useNav';

beforeEach(async () => {
  await db.providers.clear();
  await db.modelPresets.clear();
  await db.settings.clear();
  await db.configs.clear();
  await db.cards.clear();
  await db.cardFiles.clear();
  await db.assets.clear();
  await db.regexScripts.clear();
  await db.chats.clear();
  await db.messages.clear();
  await db.memories.clear();
  useNav.setState({ tab: 'settings', editingCardId: null, toast: null });
  // jsdom 沒有實作 window.confirm，會直接拋錯；這裡一律當作使用者按了「確定」
  vi.spyOn(window, 'confirm').mockReturnValue(true);
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

  it('还没有「使用中」的模型时，保存模型配置会自动切换到它（不用再手动点一次）', async () => {
    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('模型接入')).toBeTruthy());
    expect(await getActive()).toBeNull(); // 一开始就是 mock

    fireEvent.click(screen.getByText('+ 添加服务商'));
    fireEvent.change(screen.getByPlaceholderText('服务商名称'), { target: { value: '我的中转' } });
    fireEvent.click(screen.getByText('保存服务商'));
    await waitFor(() => expect(screen.getByText('我的中转')).toBeTruthy());

    fireEvent.click(screen.getByText('+ 新增模型配置'));
    fireEvent.change(screen.getByPlaceholderText(/模型名/), { target: { value: 'deepseek-chat' } });
    fireEvent.click(screen.getByText('保存模型配置'));

    await waitFor(async () => {
      const active = await getActive();
      expect(active?.preset.model).toBe('deepseek-chat');
    });
  });

  it('记忆条数：字段可以清空重打，只在保存时检查（回归：以前一删就弹回 0，打不了字）', async () => {
    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('全局配置（对所有卡片生效）')).toBeTruthy());
    const input = screen.getByLabelText('记忆条数') as HTMLInputElement;
    expect(input.value).toBe('6'); // 预设 6 条

    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');   // 清空后不会被抢回去塞 0

    fireEvent.click(screen.getByText('保存全局配置'));
    await waitFor(() => expect(screen.getByText(/记忆条数要填/)).toBeTruthy());
    expect(await db.configs.where('scope').equals('global').first()).toBeUndefined();

    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(screen.getByText('保存全局配置'));
    await waitFor(async () => {
      const cfg = await db.configs.where('scope').equals('global').first();
      expect(cfg?.memoryLimit).toBe(8);
    });
  });

  it('记忆托管开关可切换并落库，旁边有简短说明', async () => {
    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('全局配置（对所有卡片生效）')).toBeTruthy());
    expect(screen.getByText(/满下面设定的条数就归档成永久记忆/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('记忆托管开关'));
    await waitFor(async () => expect((await db.settings.get('memoryEnabled'))?.value).toBe('0'));
    fireEvent.click(screen.getByLabelText('记忆托管开关'));
    await waitFor(async () => expect((await db.settings.get('memoryEnabled'))?.value).toBe('1'));
  });

  it('恢复默认设置：清掉全局配置与字号，但保留服务商与模型配置', async () => {
    const providerId = await saveProvider({
      label: '我的中转', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-KEEP',
    });
    const presetId = await savePreset({ providerId, model: 'deepseek-chat' });
    await setActive(providerId, presetId);
    await db.settings.put({ key: 'fontScale', value: '20' });
    await db.configs.put({
      id: 'global-config', scope: 'global', refId: null, memoryLimit: 9,
      prePrompt: '前', postPrompt: '后', prompt: '提示',
    });

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('恢复与重置')).toBeTruthy());
    fireEvent.click(screen.getByText('恢复默认设置'));

    await waitFor(async () => expect(await db.configs.count()).toBe(0));
    expect(await db.settings.get('fontScale')).toBeUndefined();
    expect(await listProviders()).toHaveLength(1);
    expect((await db.providers.get(providerId))?.apiKey).toBe('sk-KEEP');
    expect((await getActive())?.preset.id).toBe(presetId);
  });

  it('恢复默认卡片：内置卡的世界书回到空', async () => {
    await ensureSeedCard();
    const pkg = (await loadCardPackage(DEMO_CARD_ID))!;
    const file = pkg.texts.find((t) => t.path === 'worldbook.json')!;
    file.text = JSON.stringify({
      version: 1,
      entries: [{
        id: 'wb-x', keys: ['甲'], secondaryKeys: [], content: '被改过',
        constant: false, selective: false, position: 'before-char', order: 0, depth: 4, recursive: false, enabled: true,
      }],
    });
    await saveCardPackage(pkg);
    expect(worldbookOf((await loadCardPackage(DEMO_CARD_ID))!)).toHaveLength(1);

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('恢复默认卡片')).toBeTruthy());
    fireEvent.click(screen.getByText('恢复默认卡片'));

    await waitFor(async () => {
      const restored = await loadCardPackage(DEMO_CARD_ID);
      expect(worldbookOf(restored!)).toHaveLength(0);
    });
  });

  it('清空本机所有数据：每一张表都清空（内置卡下次进入会自动重建）', async () => {
    await ensureSeedCard();
    await db.chats.put({
      id: 'chat_1', cardId: DEMO_CARD_ID, title: '对话', vars: {}, promptSnapshot: '',
      providerId: null, modelPresetId: null, currentLeafId: null,
      createdAt: 1, updatedAt: 1, archived: 0,
    });

    render(<SettingsScreen />);
    await waitFor(() => expect(screen.getByText('清空本机所有数据')).toBeTruthy());
    fireEvent.click(screen.getByText('清空本机所有数据'));

    await waitFor(async () => expect(await db.chats.count()).toBe(0));
    expect(await db.cards.count()).toBe(0);
  });
});
