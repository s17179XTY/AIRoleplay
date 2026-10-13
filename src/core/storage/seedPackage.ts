import { seedDemoCard } from './seed';
import { emptyCardJson, DEFAULT_MEMORY, CARD_VERSION_MARKER, type DshCardJson } from '../cards/spec';
import type { CardPackage } from '../cards/package';
import { SEED_CARD_TEMPLATE, SEED_CARD_UI_HTML } from './seedUi';

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
    persona: { name: '{{user}}', gender: '女', intro: demo.persona },
    scenario: demo.scenario,
    firstMessage: demo.firstMessage,
    mesExample: '',
    worldbook: 'worldbook.json',
    memory: { ...DEFAULT_MEMORY, ...demo.memory },
    ui: { entry: 'ui/index.html', autoOpen: true },
    promptTemplate: 'prompt.template.md',
    cover: 'assets/cover.svg',
  };
  void CARD_VERSION_MARKER;

  const texts: CardPackage['texts'] = [
    { path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: demo.worldbook }, null, 2) },
    { path: 'ui/index.html', text: SEED_CARD_UI_HTML },
    { path: 'prompt.template.md', text: SEED_CARD_TEMPLATE },
  ];

  const assets: CardPackage['assets'] = [{
    path: 'assets/cover.svg',
    mime: 'image/svg+xml',
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7bb8ff"/><stop offset="1" stop-color="#0072e3"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif">XP</text></svg>',
    ),
  }];

  return { json, texts, assets };
}
