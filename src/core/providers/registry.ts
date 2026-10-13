import { openAIAdapter } from './openai';
import { anthropicAdapter, ANTHROPIC_CAPABILITY } from './anthropic';
import type { ProviderAdapter } from './types';
import { DEFAULT_CAPABILITY, type ModelCapability } from '../storage/types';

export function adapterFor(protocol: 'openai' | 'anthropic' | 'mock'): ProviderAdapter {
  if (protocol === 'anthropic') return anthropicAdapter;
  return openAIAdapter;
}

export function defaultCapabilityFor(protocol: 'openai' | 'anthropic' | 'mock'): ModelCapability {
  if (protocol === 'anthropic') return { ...ANTHROPIC_CAPABILITY };
  return { ...DEFAULT_CAPABILITY };
}
