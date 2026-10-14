import { describe, it, expect } from 'vitest';
import { SYNC_TABLES, LOCAL_ONLY_TABLES, keyOf, sanitizeForSync, stripLocalFields, isBlobKind } from './kinds';

describe('kinds', () => {
  it('14 種 kind 都有對應表，且本地專用表不在其中', () => {
    const tables = Object.values(SYNC_TABLES);
    expect(tables).toHaveLength(14);
    for (const t of LOCAL_ONLY_TABLES) expect(tables).not.toContain(t);
  });

  it('複合主鍵的表用「:」串成穩定 id', () => {
    expect(keyOf('cardFile', { cardId: 'card_1', path: 'ui/index.html' })).toBe('card_1:ui/index.html');
    expect(keyOf('cardUiState', { cardId: 'card_1', key: 'xp' })).toBe('card_1:xp');
  });

  it('單主鍵的表直接用 row.id', () => {
    expect(keyOf('chat', { id: 'chat_1' })).toBe('chat_1');
  });

  it('provider 剝掉 apiKey 與 extraHeaders（秘密永不上雲）', () => {
    const out = sanitizeForSync('provider', {
      id: 'prov_1', label: '中轉', protocol: 'openai', baseUrl: 'https://x',
      apiKey: 'sk-secret', extraHeaders: { Authorization: 'Bearer secret' }, createdAt: 1,
    });
    expect(out).toEqual({ id: 'prov_1', label: '中轉', protocol: 'openai', baseUrl: 'https://x', createdAt: 1 });
    expect(JSON.stringify(out)).not.toContain('sk-secret');
    expect(JSON.stringify(out)).not.toContain('Bearer secret');
  });

  it('assetMeta 只同步中繼資料，bytes 交給 blob', () => {
    const out = sanitizeForSync('assetMeta', { id: 'a1', mime: 'image/png', size: 123, bytes: new ArrayBuffer(8) });
    expect(out).toEqual({ id: 'a1', mime: 'image/png', size: 123 });
    expect(isBlobKind('assetMeta')).toBe(true);
    expect(isBlobKind('chat')).toBe(false);
  });

  it('其他 kind 原樣通過，但移除同步用的 __rev', () => {
    const row = { id: 'c1', title: 't', __rev: 4 };
    expect(sanitizeForSync('chat', row)).toEqual({ id: 'c1', title: 't', __rev: 4 });
    expect(stripLocalFields(row)).toEqual({ id: 'c1', title: 't' });
  });
});
