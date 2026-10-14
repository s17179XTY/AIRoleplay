import type { CardRecord } from './types';
import type { ConfigParts, WbEntryInput } from '../assembler/types';
import { CARD_NAME, CARD_VERSION, MAIN_PROMPT, POST_PROMPT, PRE_PROMPT, SEED_CARD_ID, WORLDBOOK } from './seedContent';

export const DEMO_CARD_ID = SEED_CARD_ID;

export interface SeedCard {
  record: Omit<CardRecord, 'createdAt' | 'updatedAt'>;
  prompts: { pre: string; prompt: string; post: string };
  config: ConfigParts;
  worldbook: WbEntryInput[];
  memory: { parser: 'details-v1'; recentLimit: number; stripFromHistory: boolean; archive: 'concat' };
}

export function seedDemoCard(): SeedCard {
  return {
    record: {
      id: SEED_CARD_ID,
      name: CARD_NAME,
      author: '本地内置',
      version: CARD_VERSION,
      description: '内置示例卡：原版 HTML 互动页负责生成【初始信息设定】，卡片提示词负责写作规范，两者配合开玩。',
      tags: ['示例', '校园', '日常'],
      source: 'local',
      spec: 'dsh-card/1',
    },
    prompts: { pre: PRE_PROMPT, prompt: MAIN_PROMPT, post: POST_PROMPT },
    config: {
      prompt: '',
      prePrompt: '',
      postPrompt: '继续按上述输出格式回复，正文不少于 1500 字。',
    },
    worldbook: WORLDBOOK,
    memory: { parser: 'details-v1', recentLimit: 4, stripFromHistory: true, archive: 'concat' },
  };
}
