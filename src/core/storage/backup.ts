import { db } from './db';

export const BACKUP_VERSION = 1;

interface BackupFile {
  app: 'dsh-roleplay';
  version: number;
  exportedAt: number;
  tables: Record<string, unknown[]>;
  assets: { id: string; mime: string; size: number; data: string }[];
}

function abToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToAb(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function exportAll(): Promise<Uint8Array> {
  const tables: Record<string, unknown[]> = {
    cards: await db.cards.toArray(),
    cardFiles: await db.cardFiles.toArray(),
    chats: await db.chats.toArray(),
    messages: await db.messages.toArray(),
    memories: await db.memories.toArray(),
    worldbooks: await db.worldbooks.toArray(),
    worldbookEntries: await db.worldbookEntries.toArray(),
    regexScripts: await db.regexScripts.toArray(),
    providers: await db.providers.toArray(),
    modelPresets: await db.modelPresets.toArray(),
    configs: await db.configs.toArray(),
    cardUiState: await db.cardUiState.toArray(),
    settings: await db.settings.toArray(),
  };
  const assetRows = await db.assets.toArray();
  const file: BackupFile = {
    app: 'dsh-roleplay',
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    tables,
    assets: assetRows.map((a) => ({ id: a.id, mime: a.mime, size: a.size, data: abToBase64(a.bytes) })),
  };
  return new TextEncoder().encode(JSON.stringify(file));
}

export async function importAll(bytes: Uint8Array): Promise<void> {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as BackupFile;
  } catch {
    throw new Error('备份文件不是合法 JSON');
  }
  if (parsed.app !== 'dsh-roleplay') throw new Error('这不是本应用的备份文件');
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    throw new Error('备份版本不受支持（文件版本 ' + String(parsed.version) + '）');
  }

  await db.transaction(
    'rw',
    [db.cards, db.cardFiles, db.chats, db.messages, db.memories, db.worldbooks,
      db.worldbookEntries, db.regexScripts, db.providers, db.modelPresets, db.configs,
      db.cardUiState, db.settings, db.assets],
    async () => {
      await Promise.all([
        db.cards.clear(), db.cardFiles.clear(), db.chats.clear(), db.messages.clear(),
        db.memories.clear(), db.worldbooks.clear(), db.worldbookEntries.clear(),
        db.regexScripts.clear(), db.providers.clear(), db.modelPresets.clear(),
        db.configs.clear(), db.cardUiState.clear(), db.settings.clear(), db.assets.clear(),
      ]);
      const t = parsed.tables;
      await db.cards.bulkPut((t.cards ?? []) as never[]);
      await db.cardFiles.bulkPut((t.cardFiles ?? []) as never[]);
      await db.chats.bulkPut((t.chats ?? []) as never[]);
      await db.messages.bulkPut((t.messages ?? []) as never[]);
      await db.memories.bulkPut((t.memories ?? []) as never[]);
      await db.worldbooks.bulkPut((t.worldbooks ?? []) as never[]);
      await db.worldbookEntries.bulkPut((t.worldbookEntries ?? []) as never[]);
      await db.regexScripts.bulkPut((t.regexScripts ?? []) as never[]);
      await db.providers.bulkPut((t.providers ?? []) as never[]);
      await db.modelPresets.bulkPut((t.modelPresets ?? []) as never[]);
      await db.configs.bulkPut((t.configs ?? []) as never[]);
      await db.cardUiState.bulkPut((t.cardUiState ?? []) as never[]);
      await db.settings.bulkPut((t.settings ?? []) as never[]);
      await db.assets.bulkPut(
        (parsed.assets ?? []).map((a) => ({ id: a.id, mime: a.mime, size: a.size, bytes: base64ToAb(a.data) })),
      );
    },
  );
}
