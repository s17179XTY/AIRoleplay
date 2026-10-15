import { describe, it, expect } from 'vitest';
import {
  SYNC_TABLES, LOCAL_ONLY_TABLES, keyOf, mergeRemoteRow, sanitizeForSync, stripLocalFields, isBlobKind, type SyncKind,
} from './kinds';

describe('kinds', () => {
  it('15 種 kind 都有對應表（含 MOD），且本地專用表不在其中', () => {
    const tables = Object.values(SYNC_TABLES);
    expect(tables).toHaveLength(15);
    for (const t of LOCAL_ONLY_TABLES) expect(tables).not.toContain(t);
  });

  it('複合主鍵的表用「:」串成穩定 id', () => {
    expect(keyOf('cardFile', { cardId: 'card_1', path: 'ui/index.html' })).toBe('card_1:ui/index.html');
    expect(keyOf('cardUiState', { cardId: 'card_1', key: 'xp' })).toBe('card_1:xp');
  });

  it('單主鍵的表直接用 row.id', () => {
    expect(keyOf('chat', { id: 'chat_1' })).toBe('chat_1');
  });

  it('settings 的主鍵是 key 不是 id（唯一例外的表）', () => {
    expect(keyOf('setting', { key: 'fontSize', value: '18' })).toBe('fontSize');
  });

  it('每一種 kind 都能對自己的真實列形狀算出非 "undefined" 的 id', () => {
    const rows: Record<SyncKind, Record<string, unknown>> = {
      card: { id: 'x' }, cardFile: { cardId: 'c', path: 'ui/index.html' },
      chat: { id: 'x' }, message: { id: 'x' }, memory: { id: 'x' },
      worldbook: { id: 'x' }, worldbookEntry: { id: 'x' }, regexScript: { id: 'x' },
      config: { id: 'x' }, cardUiState: { cardId: 'c', key: 'xp' }, setting: { key: 'k' },
      provider: { id: 'x' }, modelPreset: { id: 'x' }, assetMeta: { id: 'x' }, mod: { id: 'x' },
    };
    for (const [kind, row] of Object.entries(rows)) {
      const id = keyOf(kind as SyncKind, row);
      expect(id, `${kind} 的 id 不該是 undefined`).not.toContain('undefined');
      expect(id.length).toBeGreaterThan(0);
    }
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

describe('mergeRemoteRow（同步不能吃掉本地資料）', () => {
  it('provider：遠端信封沒有秘密，套用時必須保住本地的 apiKey 與 extraHeaders', () => {
    const local = {
      id: 'prov_1', label: '舊名', protocol: 'openai', baseUrl: 'https://old',
      apiKey: 'sk-LOCAL', extraHeaders: { Authorization: 'Bearer LOCAL' }, createdAt: 1,
    };
    const remote = sanitizeForSync('provider', {
      id: 'prov_1', label: '新名', protocol: 'openai', baseUrl: 'https://new',
      apiKey: 'sk-OTHER', extraHeaders: { 'x': '1' }, createdAt: 1,
    });
    const merged = mergeRemoteRow('provider', remote, local);
    expect(merged.label).toBe('新名');       // 遠端的新值要生效
    expect(merged.baseUrl).toBe('https://new');
    expect(merged.apiKey).toBe('sk-LOCAL');   // 但秘密只認本機的
    expect(merged.extraHeaders).toEqual({ Authorization: 'Bearer LOCAL' });
  });

  it('provider：本地還沒有這一列時補成空值，不要留 undefined', () => {
    const merged = mergeRemoteRow('provider', { id: 'prov_9', label: 'B 加的', protocol: 'openai', baseUrl: 'https://x', createdAt: 2 }, null);
    expect(merged.apiKey).toBe('');
    expect(merged.extraHeaders).toEqual({});
  });

  it('cardFile：遠端只帶 __fileKey（本體走 blob）時，本地已下載的明文不能被抹掉', () => {
    const local = { cardId: 'c1', path: 'ui/index.html', kind: 'html', text: '<h1>本地已下載</h1>' };
    const merged = mergeRemoteRow('cardFile', { cardId: 'c1', path: 'ui/index.html', kind: 'html', __fileKey: 'k' }, local);
    expect(merged.text).toBe('<h1>本地已下載</h1>');
  });

  it('cardFile：遠端真的帶了 text（小檔走信封）時要用遠端的', () => {
    const local = { cardId: 'c1', path: 'a.json', kind: 'json', text: 'old' };
    const merged = mergeRemoteRow('cardFile', { cardId: 'c1', path: 'a.json', kind: 'json', text: 'new' }, local);
    expect(merged.text).toBe('new');
  });

  it('assetMeta：遠端沒有 bytes 時保住本地已抓回的二進位', () => {
    const bytes = new ArrayBuffer(4);
    const local = { id: 'a1', mime: 'image/png', size: 4, bytes };
    const merged = mergeRemoteRow('assetMeta', { id: 'a1', mime: 'image/png', size: 4 }, local);
    expect(merged.bytes).toBe(bytes);
  });

  it('一般 kind 就是遠端覆蓋本地', () => {
    const merged = mergeRemoteRow('chat', { id: 'chat_1', title: 'B 改的' }, { id: 'chat_1', title: 'A 的', vars: {} });
    expect(merged.title).toBe('B 改的');
  });
});
