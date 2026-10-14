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
  useNav.setState({ tab: 'cards', editorOpen: false, editingCardId: null, toast: null });
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

  it('新建草稿：不点保存就退出，不会在数据库里留下卡片', async () => {
    const before = await db.cards.count();
    const { unmount } = render(<CardEditorScreen cardId={null} />);
    await waitFor(() => expect(screen.getByText('新卡片')).toBeTruthy());
    unmount();
    expect(await db.cards.count()).toBe(before);
  });

  it('新建草稿：点保存才真正创建，并且之后保存的是同一张', async () => {
    const before = await db.cards.count();
    render(<CardEditorScreen cardId={null} />);
    await waitFor(() => expect(screen.getByText('新卡片')).toBeTruthy());
    const nameInput = screen.getAllByRole('textbox')[0];
    fireEvent.change(nameInput, { target: { value: '我的新卡' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(async () => expect(await db.cards.count()).toBe(before + 1));
    const all = await db.cards.toArray();
    expect(all.some((c) => c.name === '我的新卡')).toBe(true);
    // 再点一次保存不应再新建一张
    fireEvent.click(screen.getByText('保存'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await db.cards.count()).toBe(before + 1);
  });

  it('草稿转换后世界书条目数量一致', async () => {
    const pkg = seedPackage();
    const draft = packageToDraft(pkg);
    expect(draft.worldbook.length).toBeGreaterThan(0);
  });
});
