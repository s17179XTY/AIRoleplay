import { db, newId } from './db';
import type { ModelCapability, ModelParams, ModelPresetRecord, ProviderRecord } from './types';
import { DEFAULT_PARAMS } from './types';
import { adapterFor, defaultCapabilityFor } from '../providers/registry';

export const ACTIVE_PROVIDER_KEY = 'activeProviderId';
export const ACTIVE_PRESET_KEY = 'activePresetId';

export async function listProviders(): Promise<ProviderRecord[]> {
  const all = await db.providers.toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveProvider(input: Partial<ProviderRecord> & { label: string; protocol: 'openai' | 'anthropic'; baseUrl: string }): Promise<string> {
  const id = input.id ?? newId('prov_');
  const record: ProviderRecord = {
    id,
    label: input.label,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? '',
    extraHeaders: input.extraHeaders ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.providers.put(record);
  return id;
}

export async function deleteProvider(id: string): Promise<void> {
  await db.providers.delete(id);
  await db.modelPresets.where('providerId').equals(id).delete();
}

export async function listPresets(providerId?: string): Promise<ModelPresetRecord[]> {
  const all = providerId
    ? await db.modelPresets.where('providerId').equals(providerId).toArray()
    : await db.modelPresets.toArray();
  return all.sort((a, b) => a.model.localeCompare(b.model));
}

export async function savePreset(input: {
  id?: string;
  providerId: string;
  model: string;
  params?: Partial<ModelParams>;
  capabilities?: Partial<ModelCapability>;
}): Promise<string> {
  const id = input.id ?? newId('mp_');
  const provider = await db.providers.get(input.providerId);
  const protocol = provider?.protocol ?? 'openai';
  const record: ModelPresetRecord = {
    id,
    providerId: input.providerId,
    model: input.model,
    params: { ...DEFAULT_PARAMS, ...(input.params ?? {}) },
    capabilities: { ...defaultCapabilityFor(protocol), ...(input.capabilities ?? {}) },
  };
  await db.modelPresets.put(record);
  return id;
}

export async function deletePreset(id: string): Promise<void> {
  await db.modelPresets.delete(id);
  const active = await db.settings.get(ACTIVE_PRESET_KEY);
  if (active?.value === id) await db.settings.delete(ACTIVE_PRESET_KEY);
}

export async function getActive(): Promise<{ provider: ProviderRecord; preset: ModelPresetRecord } | null> {
  const providerId = (await db.settings.get(ACTIVE_PROVIDER_KEY))?.value;
  const presetId = (await db.settings.get(ACTIVE_PRESET_KEY))?.value;
  if (!providerId || !presetId) return null;
  const provider = await db.providers.get(providerId);
  const preset = await db.modelPresets.get(presetId);
  if (!provider || !preset) return null;
  return { provider, preset };
}

export async function setActive(providerId: string | null, presetId: string | null): Promise<void> {
  if (providerId && presetId) {
    await db.settings.put({ key: ACTIVE_PROVIDER_KEY, value: providerId });
    await db.settings.put({ key: ACTIVE_PRESET_KEY, value: presetId });
  } else {
    await db.settings.delete(ACTIVE_PROVIDER_KEY);
    await db.settings.delete(ACTIVE_PRESET_KEY);
  }
}

export async function testConnection(provider: ProviderRecord): Promise<string[]> {
  const adapter = adapterFor(provider.protocol);
  return adapter.listModels({
    id: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    extraHeaders: provider.extraHeaders,
  });
}
