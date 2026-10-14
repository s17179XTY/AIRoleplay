export type SyncKind =
  | 'card' | 'cardFile' | 'chat' | 'message' | 'memory'
  | 'worldbook' | 'worldbookEntry' | 'regexScript' | 'config'
  | 'cardUiState' | 'setting' | 'provider' | 'modelPreset' | 'assetMeta';

export const SYNC_TABLES: Record<SyncKind, string> = {
  card: 'cards',
  cardFile: 'cardFiles',
  chat: 'chats',
  message: 'messages',
  memory: 'memories',
  worldbook: 'worldbooks',
  worldbookEntry: 'worldbookEntries',
  regexScript: 'regexScripts',
  config: 'configs',
  cardUiState: 'cardUiState',
  setting: 'settings',
  provider: 'providers',
  modelPreset: 'modelPresets',
  assetMeta: 'assets',
};

export const LOCAL_ONLY_TABLES = ['syncOutbox', 'syncState', 'syncConflicts', 'blobState'];

/** 二進位本體走 blob 通道，信封只帶中繼資料 */
export function isBlobKind(kind: SyncKind): boolean {
  return kind === 'assetMeta';
}

export function keyOf(kind: SyncKind, row: Record<string, unknown>): string {
  if (kind === 'cardFile') return `${String(row.cardId)}:${String(row.path)}`;
  if (kind === 'cardUiState') return `${String(row.cardId)}:${String(row.key)}`;
  return String(row.id);
}

export function stripLocalFields(row: Record<string, unknown>): Record<string, unknown> {
  const { __rev: _ignored, ...rest } = row;
  return rest;
}

export function sanitizeForSync(kind: SyncKind, row: Record<string, unknown>): Record<string, unknown> {
  // apiKey 與 extraHeaders 都可能承載秘密（後者常被塞自訂 Authorization），兩個都不上雲。
  if (kind === 'provider') {
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      baseUrl: row.baseUrl,
      createdAt: row.createdAt,
    };
  }
  // 素材的二進位本體走 blob，信封只帶中繼資料。
  if (kind === 'assetMeta') {
    return { id: row.id, mime: row.mime, size: row.size };
  }
  return { ...row };
}
