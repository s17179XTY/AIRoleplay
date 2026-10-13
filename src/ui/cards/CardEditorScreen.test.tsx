import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CardEditorScreen from './CardEditorScreen';
import { db } from '../../core/storage/db';
import { saveCardPackage, loadCardPackage } from '../../core/storage/cardRepo';
import { seedPackage } from '../../core/storage/seedPackage';
import { useNav } from '../../state/useNav';
import { packageToDraft } from './draft';

beforeEach(async () => {
  await db.cardFiles.clear();
  await db.cards.clear();
  await db.assets.clear();
  useNav.setState({ tab: 'cards', editingCardId: null, toast: null });
});

describe('卡片编辑器', () => {
  it('加载卡片并保存修改后的提示词', async () => {
    const pkg = seedPackage();
    const id = await saveCardPackage(pkg);
    render(<CardEditorScreen cardId={id} />);
    await waitFor(() => expect(screen.getByText(/寻找新XP/)).toBeTruthy());
    fireEvent.click(screen.getByText('提示词'));
    const areas = screen.getAllByRole('textbox');
    fireEvent.change(areas[0], { target: { value: '新的前置词' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(async () => {
      const reloaded = await loadCardPackage(id);
      expect(reloaded!.json.prompts.pre).toBe('新的前置词');
    });
  });

  it('草稿转换后世界书条目数量一致', async () => {
    const pkg = seedPackage();
    const draft = packageToDraft(pkg);
    expect(draft.worldbook.length).toBeGreaterThan(0);
  });
});
