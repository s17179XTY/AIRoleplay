import Dexie, { type Table } from 'dexie';
import type {
  AssetRecord, CardFileRecord, CardRecord, CardUiStateRecord, ChatRecord, ConfigRecord,
  MemoryRecord, MessageRecord, ModelPresetRecord, ProviderRecord, RegexScriptRecord,
  SettingRecord, WorldbookEntryRecord, WorldbookRecord,
} from './types';

export class DshDB extends Dexie {
  cards!: Table<CardRecord, string>;
  cardFiles!: Table<CardFileRecord, [string, string]>;
  assets!: Table<AssetRecord, string>;
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  memories!: Table<MemoryRecord, string>;
  worldbooks!: Table<WorldbookRecord, string>;
  worldbookEntries!: Table<WorldbookEntryRecord, string>;
  regexScripts!: Table<RegexScriptRecord, string>;
  providers!: Table<ProviderRecord, string>;
  modelPresets!: Table<ModelPresetRecord, string>;
  configs!: Table<ConfigRecord, string>;
  cardUiState!: Table<CardUiStateRecord, [string, string]>;
  settings!: Table<SettingRecord, string>;

  constructor(name = 'dsh-roleplay') {
    super(name);
    this.version(1).stores({
      cards: 'id, updatedAt, name, *tags',
      cardFiles: '[cardId+path], cardId, kind',
      assets: 'id',
      chats: 'id, cardId, updatedAt',
      messages: 'id, chatId, parentId, [chatId+createdAt]',
      memories: 'id, chatId, [chatId+tier]',
      worldbooks: 'id',
      worldbookEntries: 'id, worldbookId, *keys',
      regexScripts: 'id, scope, chatId',
      providers: 'id',
      modelPresets: 'id, providerId',
      configs: 'id, scope, refId',
      cardUiState: '[cardId+key]',
      settings: 'key',
    });
  }
}

export const db = new DshDB();

export function newId(prefix = ''): string {
  return prefix + crypto.randomUUID();
}
