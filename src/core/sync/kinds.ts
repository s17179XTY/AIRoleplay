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
  // settings 是 14 張表裡唯一主鍵叫 key 而不是 id 的（見 storage/db.ts 的 schema）
  if (kind === 'setting') return String(row.key);
  return String(row.id);
}

export function stripLocalFields(row: Record<string, unknown>): Record<string, unknown> {
  const { __rev: _ignored, ...rest } = row;
  return rest;
}

/**
 * 把遠端信封套用到本地列時，**不能直接整列覆蓋**。
 *
 * 信封裡刻意少了兩種東西：
 * 1. 永不上雲的祕密（`provider.apiKey` / `provider.extraHeaders`）；
 * 2. 已經走 blob 通道的二進位本體（`cardFile.text` / `asset.bytes`，信封只留 `__fileKey`）。
 *
 * 直接 `put` 會把本地這幾個欄位一起抹成 undefined——使用者看到的就是
 * 「同步後 API Key 變空要重填」「剛同步完互動頁/圖片不見了」。
 * 所以一律以本地現有的列為底，只覆蓋信封真的帶過來的欄位。
 */
export function mergeRemoteRow(
  kind: SyncKind,
  remote: Record<string, unknown>,
  local: Record<string, unknown> | null,
): Record<string, unknown> {
  if (kind === 'provider') {
    // 就算本地還沒有這一列（另一台裝置新增的服務商），也要補上空字串，
    // 否則 UI 會拿到 undefined，React 受控 input 直接變成未受控。
    return {
      ...(local ?? {}),
      ...remote,
      apiKey: (local?.apiKey as string | undefined) ?? '',
      extraHeaders: (local?.extraHeaders as Record<string, string> | undefined) ?? {},
    };
  }
  if (!local) return remote;

  const merged = { ...local, ...remote };
  // 走過 blob 的記錄：本體不在信封裡，本地若已經有明文就必須留著（否則要等下一次抓 blob）
  if (kind === 'cardFile' && typeof remote.text !== 'string' && typeof local.text === 'string') {
    merged.text = local.text;
  }
  if (kind === 'assetMeta' && remote.bytes === undefined && local.bytes !== undefined) {
    merged.bytes = local.bytes;
  }
  return merged;
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
