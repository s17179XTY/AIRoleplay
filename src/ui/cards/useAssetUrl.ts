import { useEffect, useState } from 'react';
import { db } from '../../core/storage/db';

/**
 * 把 `assets` 表里的图片变成一个可以放进 <img src> 的 object URL。
 * 用完（卸载或换图）一定要 revoke，否则每换一次图就漏一个 URL。
 */
export function useAssetUrl(assetId: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    void (async () => {
      if (!assetId) {
        setUrl(null);
        return;
      }
      const row = await db.assets.get(assetId).catch(() => undefined);
      if (!row || revoked) return;
      created = URL.createObjectURL(new Blob([row.bytes], { type: row.mime }));
      setUrl(created);
    })();
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [assetId]);

  return url;
}

/** 手上已经有 bytes（例如卡片包里的 assets）时用这个，不必再查库 */
export function useBlobUrl(bytes: Uint8Array | undefined, mime: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes || !mime) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [bytes, mime]);
  return url;
}
