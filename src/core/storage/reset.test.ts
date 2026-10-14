import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { clearLocalData, resetDefaultCards, resetSettings, localDataSummary } from './reset';
import { getActive, listProviders, savePreset, saveProvider, setActive } from './providerRepo';
import { DEMO_CARD_ID } from './seed';
import { ensureSeedCard, loadCardPackage, saveCardPackage, worldbookOf } from './cardRepo';
import { packCard, unpackCard, type CardPackage } from '../cards/package';

async function clearAll(): Promise<void> {
  for (const t of db.tables) await t.clear();
}

beforeEach(clearAll);

describe('恢复与重置', () => {
  it('resetSettings 清掉全局配置与一般设置，但保留服务商、模型配置与「使用中」选择', async () => {
    const providerId = await saveProvider({
      label: '我的中转', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-KEEP',
    });
    const presetId = await savePreset({ providerId, model: 'deepseek-chat' });
    await setActive(providerId, presetId);
    await db.settings.put({ key: 'fontScale', value: '20' });
    await db.settings.put({ key: 'memoryEnabled', value: '0' });
    await db.configs.put({
      id: 'global-config', scope: 'global', refId: null, memoryLimit: 9,
      prePrompt: '前', postPrompt: '后', prompt: '提示',
    });
    await db.regexScripts.put({
      id: 'rx_1', scope: 'global', chatId: null, name: '规则', pattern: 'a',
      flags: 'g', replacement: 'b', enabled: true, order: 0, target: 'display',
    });

    const result = await resetSettings();
    expect(result.configs).toBe(1);

    // 該清掉的
    expect(await db.configs.count()).toBe(0);
    expect(await db.settings.get('fontScale')).toBeUndefined();
    expect(await db.settings.get('memoryEnabled')).toBeUndefined();
    // 該留的
    expect(await listProviders()).toHaveLength(1);
    expect((await db.providers.get(providerId))?.apiKey).toBe('sk-KEEP');
    expect((await getActive())?.preset.id).toBe(presetId);
    // 正則腳本不屬於「預設設定」，保持不動
    expect(await db.regexScripts.count()).toBe(1);
  });

  it('resetDefaultCards 會把内置卡還原成出廠狀態（含空世界書）', async () => {
    await ensureSeedCard();
    // 使用者把内置卡的世界書改髒了
    const pkg = (await loadCardPackage(DEMO_CARD_ID)) as CardPackage;
    const file = pkg.texts.find((t) => t.path === 'worldbook.json');
    const entries = [{
      id: 'wb-x', keys: ['甲'], secondaryKeys: [], content: '被改過',
      constant: false, selective: false, position: 'before-char' as const,
      order: 0, depth: 4, recursive: false, enabled: true,
    }];
    if (file) file.text = JSON.stringify({ version: 1, entries });
    await saveCardPackage(pkg);
    expect(worldbookOf((await loadCardPackage(DEMO_CARD_ID))!)).toHaveLength(1);

    await resetDefaultCards();
    const restored = await loadCardPackage(DEMO_CARD_ID);
    expect(restored).not.toBeNull();
    expect(worldbookOf(restored!)).toHaveLength(0);
    // 卡片包仍然是完整可打包的（互動頁还在）
    expect(unpackCard(packCard(restored!)).texts.map((t) => t.path)).toContain('ui/index.html');
  });

  it('clearLocalData 清空所有本地表（含同步用的 outbox / 游标）', async () => {
    await ensureSeedCard();
    await db.messages.put({
      id: 'm1', chatId: 'c1', parentId: null, role: 'user', raw: 'hi',
      status: 'complete', tokensIn: 0, tokensOut: 0, model: '', createdAt: 1,
    });
    await db.syncOutbox.put({ kind: 'message', id: 'm1', deleted: 0, queuedAt: 1 });
    await db.syncState.put({ key: 'cursor', value: '42' });
    expect((await localDataSummary()).messages).toBe(1);

    await clearLocalData();
    for (const table of db.tables) {
      expect(await table.count(), table.name + ' 应该被清空').toBe(0);
    }
  });
});
