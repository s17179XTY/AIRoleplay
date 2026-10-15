import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CardEditorScreen from './CardEditorScreen';
import { db } from '../../core/storage/db';
import { saveCardPackage, loadCardPackage } from '../../core/storage/cardRepo';
import { seedPackage } from '../../core/storage/seedPackage';
import { useNav } from '../../state/useNav';
import { packageToDraft, draftToPackage } from './draft';

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
    // 內置卡的世界書是空的，測試自己塞兩條進去驗往返數量
    const file = pkg.texts.find((t) => t.path === 'worldbook.json')!;
    const entries = ['甲', '乙'].map((k, i) => ({
      id: 'wb-' + i, keys: [k], secondaryKeys: [], content: k + '的内容',
      constant: false, selective: false, position: 'before-char' as const,
      order: i, depth: 4, recursive: false, enabled: true,
    }));
    file.text = JSON.stringify({ version: 1, entries });
    const draft = packageToDraft(pkg);
    expect(draft.worldbook).toHaveLength(2);
    expect(packageToDraft(draftToPackage(draft, pkg)).worldbook).toHaveLength(2);
  });

  it('没登录时「上传图片」被禁用，但已有封面照常显示', async () => {
    const pkg = seedPackage();
    const id = await saveCardPackage(pkg);
    render(<CardEditorScreen cardId={id} />);
    await waitFor(() => expect(screen.getByText(/寻找新XP/)).toBeTruthy());

    // 内置卡自带一张 cover.svg → 应该有 <img>，而且上传按钮是禁用的
    await waitFor(() => expect(screen.getByTestId('upload-cover').hasAttribute('disabled')).toBe(true));
    expect(screen.getByTestId('upload-avatar').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/登录后才能上传图片/)).toBeTruthy();
    expect(document.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('基本页不再有「主人公设定 / 前情提要 / 开场白」三个输入框', async () => {
    const pkg = seedPackage();
    const id = await saveCardPackage(pkg);
    render(<CardEditorScreen cardId={id} />);
    await waitFor(() => expect(screen.getByText(/寻找新XP/)).toBeTruthy());
    expect(screen.queryByText('主人公设定')).toBeNull();
    expect(screen.queryByText('前情提要')).toBeNull();
    expect(screen.queryByText(/开场白/)).toBeNull();
    // 简介还在，而且说明改成「不会进提示词」
    expect(screen.getByText(/简介（只在卡片列表显示，不会进提示词）/)).toBeTruthy();
  });
});
