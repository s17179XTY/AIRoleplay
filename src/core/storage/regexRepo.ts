import { db } from './db';
import { fromCardJson, fromRecord, type RegexRule } from '../cards/regex';
import { regexOf } from './cardRepo';
import type { CardPackage } from '../cards/package';

export async function loadRulesForChat(chatId: string | null, card?: CardPackage | null): Promise<RegexRule[]> {
  const globalRecords = await db.regexScripts.where('scope').equals('global').toArray();
  const chatRecords = chatId
    ? (await db.regexScripts.where('scope').equals('chat').toArray()).filter((r) => r.chatId === chatId)
    : [];
  const cardRules = card ? regexOf(card).map(fromCardJson) : [];
  return [...globalRecords.map(fromRecord), ...chatRecords.map(fromRecord), ...cardRules];
}

export function displayRules(rules: RegexRule[]): RegexRule[] {
  return rules.filter((r) => r.target === 'display');
}

export function promptRules(rules: RegexRule[]): RegexRule[] {
  return rules.filter((r) => r.target === 'prompt');
}
