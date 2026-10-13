import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CardUiScreen, { setFieldCollector } from './CardUiScreen';
import { db } from '../../core/storage/db';
import { saveCardPackage } from '../../core/storage/cardRepo';
import { seedPackage } from '../../core/storage/seedPackage';
import { useNav } from '../../state/useNav';
import { useSession } from '../../state/useSession';
import { createMockAdapter } from '../../core/providers/mock';
import { setAdapter } from '../../state/useSession';

beforeEach(async () => {
  await db.cardFiles.clear();
  await db.cards.clear();
  await db.assets.clear();
  await db.chats.clear();
  await db.messages.clear();
  await db.settings.clear();
  await db.providers.clear();
  await db.modelPresets.clear();
  useNav.setState({ tab: 'cards', editingCardId: null, uiCardId: null, toast: null });
  useSession.setState({ ready: false, cardId: null, cardName: '', card: null, modelLabel: 'mock', chatId: null, messages: [], draft: '', streaming: false, error: null });
  setAdapter(createMockAdapter('模拟回复', { chunkSize: 500, delayMs: 0 }));
  setFieldCollector(async () => ({
    xp: { values: ['A01', 'B02'], labels: ['校园日常', '读心能力'] },
    userName: { values: ['苏小染'], labels: ['苏小染'] },
    scenario: { values: ['秋末冬初的午后，市一中三楼女厕所。'], labels: ['秋末冬初的午后，市一中三楼女厕所。'] },
    worldview: { values: ['现代都市日常，高中校园背景。'], labels: ['现代都市日常，高中校园背景。'] },
  }));
});

describe('卡片交互界面', () => {
  it('勾选后生成提示词，并一键开始把设定作为首条输入', async () => {
    const pkg = seedPackage();
    const id = await saveCardPackage(pkg);
    render(<CardUiScreen cardId={id} />);
    await waitFor(() => expect(screen.getByText('生成提示词')).toBeTruthy());

    fireEvent.click(screen.getByText('生成提示词'));
    await waitFor(() => expect(screen.getByText('提示词预览')).toBeTruthy());
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(area.value).toContain('【初始信息设定】');
    expect(area.value).toContain('校园日常');
    expect(area.value).toContain('读心能力');
    expect(area.value).toContain('市一中');
    expect(area.value).toContain('苏小染');

    fireEvent.click(screen.getByText('开始游玩'));
    await waitFor(async () => {
      const chats = await db.chats.where('cardId').equals(id).toArray();
      expect(chats).toHaveLength(1);
      expect(chats[0].promptSnapshot).toContain('校园日常');
    });
    await waitFor(() => expect(useSession.getState().messages.length).toBeGreaterThan(0));
    expect(useSession.getState().messages[0].role).toBe('user');
    expect(useSession.getState().messages[0].raw).toContain('校园日常');
  });

  it('跳过界面会直接以开场白建立会话', async () => {
    const pkg = seedPackage();
    const id = await saveCardPackage(pkg);
    render(<CardUiScreen cardId={id} />);
    await waitFor(() => expect(screen.getByText('跳过界面')).toBeTruthy());
    fireEvent.click(screen.getByText('跳过界面'));
    await waitFor(() => expect(useSession.getState().chatId).toBeTruthy());
    expect(useSession.getState().messages[0].raw).toContain('洗手台');
  });
});
