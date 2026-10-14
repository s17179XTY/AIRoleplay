import type { Env, KVNamespace } from '../../src/types';

export interface TestKV extends KVNamespace {
  /** 模擬 KV 的最終一致性：剛寫入的 key 可以暫時「還讀不到」 */
  setVisible(key: string, visible: boolean): void;
  keys(): string[];
}

/**
 * 記憶體版 KV，行為對齊我們會用到的 Cloudflare KV 部分。
 * 最後用 `as unknown as TestKV` 收尾：KVNamespace['get'] 是**多載**簽名（arrayBuffer / string），
 * 單一實作函式在型別上滿足不了多載，這是 TS 的已知限制，不是設計問題。
 */
export function makeTestKV(): TestKV {
  const store = new Map<string, Uint8Array>();
  const visible = new Set<string>();

  const impl = {
    async put(key: string, value: Uint8Array | ArrayBuffer): Promise<void> {
      store.set(key, value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value));
      visible.add(key);
    },
    async get(key: string, type?: 'arrayBuffer'): Promise<ArrayBuffer | string | null> {
      if (!visible.has(key)) return null;
      const found = store.get(key);
      if (!found) return null;
      if (type === 'arrayBuffer') return found.slice().buffer;
      return new TextDecoder().decode(found);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
      visible.delete(key);
    },
    async list(options: { prefix?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? '';
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limited = names.slice(0, options.limit ?? 1000);
      return { keys: limited.map((name) => ({ name })), list_complete: limited.length === names.length };
    },
    setVisible(key: string, value: boolean): void {
      if (value) visible.add(key);
      else visible.delete(key);
    },
    keys: (): string[] => [...store.keys()],
  };

  return impl as unknown as TestKV;
}

/** 從 Env 取出測試用 KV（makeTestEnv 建的就是 makeTestKV） */
export function testKV(env: Env): TestKV {
  return env.BLOBS as TestKV;
}
