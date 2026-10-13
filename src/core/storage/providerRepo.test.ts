import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { deleteProvider, getActive, listPresets, savePreset, saveProvider, setActive } from './providerRepo';
import { toAnthropicPayload, ANTHROPIC_CAPABILITY } from '../providers/anthropic';
import { defaultCapabilityFor, adapterFor } from '../providers/registry';
import { DEFAULT_PARAMS } from './types';

beforeEach(async () => {
  await db.providers.clear();
  await db.modelPresets.clear();
  await db.settings.clear();
});

describe('模型接入仓库', () => {
  it('保存服务商与配置，并设为当前', async () => {
    const pid = await saveProvider({ label: '本地中转', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-1' });
    const mid = await savePreset({ providerId: pid, model: 'deepseek-chat' });
    await setActive(pid, mid);
    const active = await getActive();
    expect(active?.provider.label).toBe('本地中转');
    expect(active?.preset.model).toBe('deepseek-chat');
    expect(active?.preset.capabilities.temperature).toBe(true);
  });

  it('删除服务商会连带删除其模型配置', async () => {
    const pid = await saveProvider({ label: 'X', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    await savePreset({ providerId: pid, model: 'claude-sonnet-4-5' });
    expect(await listPresets(pid)).toHaveLength(1);
    await deleteProvider(pid);
    expect(await listPresets(pid)).toHaveLength(0);
    expect(await getActive()).toBeNull();
  });

  it('Anthropic 协议默认能力矩阵不同', () => {
    expect(defaultCapabilityFor('anthropic').presencePenalty).toBe(false);
    expect(defaultCapabilityFor('anthropic').contextLength).toBe(200000);
    expect(adapterFor('anthropic').id).toBe('anthropic');
  });
});

describe('Anthropic 载荷映射', () => {
  it('系统条目进 system，历史进 messages，后置词并入最后一条 user', () => {
    const payload = toAnthropicPayload({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: '卡片提示词', position: 'system' },
        { role: 'user', content: '历史第一句', position: 'history' },
        { role: 'assistant', content: '历史回复', position: 'history' },
        { role: 'system', content: '后置词', position: 'post' },
        { role: 'user', content: '本轮输入', position: 'post' },
      ],
      params: { ...DEFAULT_PARAMS, maxTokens: 2048 },
      capabilities: ANTHROPIC_CAPABILITY,
    });
    expect(payload.system).toContain('卡片提示词');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]).toEqual({ role: 'user', content: '历史第一句' });
    expect(payload.messages[1]).toEqual({ role: 'assistant', content: '历史回复' });
    expect(payload.messages[2].role).toBe('user');
    expect(payload.messages[2].content).toContain('后置词');
    expect(payload.messages[2].content).toContain('本轮输入');
    expect(payload.max_tokens).toBe(2048);
  });
});
