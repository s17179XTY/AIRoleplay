import uiHtml from '../../assets/cards/fengyue-demo/ui.html?raw';
import { seedDemoCard } from './seed';
import { emptyCardJson, DEFAULT_MEMORY, type DshCardJson } from '../cards/spec';
import type { CardPackage } from '../cards/package';

export const CARD_PAGE_ENTRY = 'ui/index.html';

export function seedPackage(): CardPackage {
  const demo = seedDemoCard();
  const json: DshCardJson = {
    ...emptyCardJson(demo.record.name),
    id: demo.record.id,
    author: demo.record.author,
    version: demo.record.version,
    description: demo.record.description,
    tags: demo.record.tags,
    prompts: { ...demo.prompts },
    // 主人公设定 / 前情提要 / 初始剧情 / 开场白 全部由互动页里的【初始信息设定】决定
    persona: { name: '{{user}}', gender: '', intro: '' },
    scenario: '',
    firstMessage: '',
    mesExample: '',
    worldbook: 'worldbook.json',
    memory: { ...DEFAULT_MEMORY, ...demo.memory },
    ui: { entry: CARD_PAGE_ENTRY, autoOpen: true },
    cover: 'assets/cover.svg',
  };

  const texts: CardPackage['texts'] = [
    { path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: demo.worldbook }, null, 2) },
    { path: CARD_PAGE_ENTRY, text: uiHtml },
  ];

  const assets: CardPackage['assets'] = [{
    path: 'assets/cover.svg',
    mime: 'image/svg+xml',
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7bb8ff"/><stop offset="1" stop-color="#0072e3"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="42" font-size="26" text-anchor="middle" fill="#fff" font-family="sans-serif">XP</text></svg>',
    ),
  }];

  return { json, texts, assets };
}
