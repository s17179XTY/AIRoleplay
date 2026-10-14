export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface PulledRecord {
  kind: string;
  id: string;
  deleted: boolean;
  rev?: number;
  updatedAt?: number;
  size?: number;
  ciphertext?: string;
  blobRef?: string;
}

export interface PullResult {
  cursor: number;
  hasMore: boolean;
  records: PulledRecord[];
  quota: { used: number; limit: number };
}

export interface PushPayload {
  records: Array<{
    kind: string;
    id: string;
    rev: number;
    baseRev: number;
    updatedAt: number;
    deleted?: boolean;
    size: number;
    ciphertext?: string;
    blobRef?: string;
  }>;
}

export interface PushResult {
  accepted: Array<{ kind: string; id: string; rev: number }>;
  conflicts: Array<{ kind: string; id: string; serverRev: number; serverCiphertext?: string }>;
  quota: { used: number; limit: number };
}

export interface MeResult {
  username: string;
  createdAt: number;
  quota: { used: number; limit: number };
  /** 被 masterKey 加密過的 DEK（密文，不是秘密） */
  wrappedDek: string;
  /** KDF 描述子（迭代數等），登入後用來確認本機參數是否一致 */
  kdf: string;
}

export class SyncApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

export interface SyncClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getTokens?: () => Tokens | null;
  onTokens?: (tokens: Tokens | null) => void;
}

export interface RegisterInput {
  username: string;
  inviteCode: string;
  authKey: string;
  kdf: string;
  wrappedDek: string;
  recoveryAuthKey: string;
  recoveryWrappedDek: string;
  label?: string;
}

export interface AuthResult extends Tokens {
  username: string;
}

export interface SyncClient {
  register(input: RegisterInput): Promise<AuthResult>;
  login(input: { username: string; authKey: string; label?: string }): Promise<AuthResult>;
  logout(): Promise<void>;
  me(): Promise<MeResult>;
  pull(cursor: number, limit?: number): Promise<PullResult>;
  push(payload: PushPayload): Promise<PushResult>;
  putBlob(blobId: string, bytes: Uint8Array): Promise<{ size: number }>;
  /** 404 回 null：KV 是最終一致的，剛上傳的檔案可能還讀不到，呼叫端要「稍後重試」而不是當失敗 */
  getBlob(blobId: string): Promise<Uint8Array | null>;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

export function createSyncClient(opts: SyncClientOptions): SyncClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  let tokens: Tokens | null = opts.getTokens?.() ?? null;

  function setTokens(next: Tokens | null): void {
    tokens = next;
    opts.onTokens?.(next);
  }

  async function raw(path: string, init: CallOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.auth !== false && tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
    const response = await doFetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { code: 'bad_response', message: text.slice(0, 120) };
      }
    }
    if (!response.ok) {
      throw new SyncApiError(
        response.status,
        typeof parsed.code === 'string' ? parsed.code : 'http_error',
        typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`,
      );
    }
    return parsed;
  }

  async function refresh(): Promise<boolean> {
    if (!tokens) return false;
    try {
      const out = (await raw('/api/auth/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
        auth: false,
      })) as { accessToken: string; refreshToken: string };
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return true;
    } catch {
      setTokens(null);
      return false;
    }
  }

  async function call<T>(path: string, init: CallOptions = {}): Promise<T> {
    try {
      return (await raw(path, init)) as T;
    } catch (err) {
      // 401 只重試一次：refresh 成功才重打，避免無限迴圈
      if (err instanceof SyncApiError && err.status === 401 && init.auth !== false && (await refresh())) {
        return (await raw(path, init)) as T;
      }
      throw err;
    }
  }

  /** 二進位通道：不吃 JSON，也不把 ArrayBuffer 塞進 JSON */
  async function binary(path: string, method: 'PUT' | 'GET', body?: Uint8Array): Promise<Response> {
    const send = (): Promise<Response> => {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
      return doFetch(`${base}${path}`, {
        method,
        headers,
        body: body ? (body.slice().buffer as ArrayBuffer) : undefined,
      });
    };
    const first = await send();
    if (first.status === 401 && (await refresh())) return send();
    return first;
  }

  return {
    async register(input) {
      const out = await call<AuthResult>('/api/auth/register', { method: 'POST', body: input, auth: false });
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return out;
    },
    async login(input) {
      const out = await call<AuthResult>('/api/auth/login', { method: 'POST', body: input, auth: false });
      setTokens({ accessToken: out.accessToken, refreshToken: out.refreshToken });
      return out;
    },
    async logout() {
      try {
        await call('/api/auth/logout', { method: 'POST' });
      } finally {
        // 不論伺服器成不成功，本地一定要清掉 token
        setTokens(null);
      }
    },
    async me() {
      return call<MeResult>('/api/me');
    },
    async pull(cursor, limit = 200) {
      return call<PullResult>(`/api/sync/pull?cursor=${cursor}&limit=${limit}`);
    },
    async push(payload) {
      return call<PushResult>('/api/sync/push', { method: 'POST', body: payload });
    },
    async putBlob(blobId, bytes) {
      const res = await binary(`/api/blob/${encodeURIComponent(blobId)}`, 'PUT', bytes);
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      if (text) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
      }
      if (!res.ok) {
        throw new SyncApiError(
          res.status,
          typeof parsed.code === 'string' ? parsed.code : 'http_error',
          typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.status}`,
        );
      }
      return { size: Number(parsed.size ?? bytes.byteLength) };
    },
    async getBlob(blobId) {
      const res = await binary(`/api/blob/${encodeURIComponent(blobId)}`, 'GET');
      // 404 = 還沒傳播到這個節點（KV 最終一致）→ 回 null 讓引擎稍後重試
      if (res.status === 404) return null;
      if (!res.ok) throw new SyncApiError(res.status, 'blob_error', `HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
