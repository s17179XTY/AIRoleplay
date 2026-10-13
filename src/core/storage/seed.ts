import type { CardRecord } from './types';
import type { ConfigParts, WbEntryInput } from '../assembler/types';
import {
  CARD_NAME, CARD_VERSION, FIRST_MESSAGE, MAIN_PROMPT, PERSONA, POST_PROMPT,
  PRE_PROMPT, SCENARIO, SEED_CARD_ID, WORLDBOOK,
} from './seedContent';

export const DEMO_CARD_ID = SEED_CARD_ID;

export interface SeedCard {
  record: Omit<CardRecord, 'createdAt' | 'updatedAt'>;
  prompts: { pre: string; prompt: string; post: string };
  persona: string;
  scenario: string;
  firstMessage: string;
  config: ConfigParts;
  worldbook: WbEntryInput[];
  memory: { parser: 'details-v1'; recentLimit: number; stripFromHistory: boolean; archive: 'concat' };
}

export function seedDemoCard(): SeedCard {
  return {
    record: {
      id: SEED_CARD_ID,
      name: CARD_NAME,
      author: '内置示例',
      version: CARD_VERSION,
      description: '内置示例卡：多层提示词（前置词 / 提示词 / 后置词）+ 世界书 + 记忆托管 + 输出格式约束 + XP 选择交互界面。',
      tags: ['示例', '校园', '日常'],
      source: 'local',
      spec: 'dsh-card/1',
    },
    prompts: { pre: PRE_PROMPT, prompt: MAIN_PROMPT, post: POST_PROMPT },
    persona: PERSONA,
    scenario: SCENARIO,
    firstMessage: FIRST_MESSAGE,
    config: {
      prompt: '',
      prePrompt: '',
      postPrompt: '继续按上述输出格式回复，正文不少于 1500 字。',
    },
    worldbook: WORLDBOOK,
    memory: { parser: 'details-v1', recentLimit: 4, stripFromHistory: true, archive: 'concat' },
  };
}
