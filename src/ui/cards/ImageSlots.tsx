import { useEffect, useRef, useState } from 'react';
import { readFileBytes } from './fileUtils';
import {
  AVATAR_MAX_EDGE, COVER_MAX_EDGE, assertUploadableImage, compressImage,
} from '../../core/storage/image';
import type { CardPackage } from '../../core/cards/package';
import { useSync } from '../../state/useSync';
import { useNav } from '../../state/useNav';

/**
 * 卡片的封面与聊天头像。
 *
 * 账号门槛：**没登录时不给上传**（按钮禁用），但已经有图的话照常显示。
 * 注意这只是产品门槛、不是安全边界（谁都能注册）——真正的防护是 image.ts 的
 * magic byte 白名单 / 拒绝 SVG / 体积与边长上限。
 */
export default function ImageSlots({ pkg, onChange }: {
  pkg: CardPackage;
  onChange: (next: CardPackage) => void;
}) {
  const coverRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const username = useSync((s) => s.username);
  const showToast = useNav((s) => s.showToast);
  const canUpload = Boolean(username);

  const pick = async (file: File, slot: 'cover' | 'avatar') => {
    try {
      const raw = await readFileBytes(file);
      const bytes = new Uint8Array(raw);
      const mime = assertUploadableImage(bytes);
      const out = await compressImage(bytes, mime, slot === 'cover' ? COVER_MAX_EDGE : AVATAR_MAX_EDGE);
      const path = slot === 'cover' ? 'assets/cover.png' : 'assets/avatar.png';
      const next: CardPackage = {
        ...pkg,
        assets: [...pkg.assets.filter((a) => a.path !== path), { path, mime: out.mime, bytes: out.bytes }],
      };
      if (slot === 'cover') next.json = { ...pkg.json, cover: path };
      else next.json = { ...pkg.json, avatar: path };
      onChange(next);
      showToast(slot === 'cover' ? '封面已更新，记得点右上角保存' : '头像已更新，记得点右上角保存');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const current = (slot: 'cover' | 'avatar') => {
    const path = slot === 'cover' ? (pkg.json.cover ?? 'assets/cover.png') : 'assets/avatar.png';
    return pkg.assets.find((a) => a.path === path);
  };

  return (
    <div className="dsh-card p-3.5">
      <div className="mb-2 text-[12px] text-slate-500">图片（封面显示在卡片列表，头像显示在聊天气泡旁边）</div>
      <div className="flex gap-4">
        {(['cover', 'avatar'] as const).map((slot) => {
          const asset = current(slot);
          const ref = slot === 'cover' ? coverRef : avatarRef;
          return (
            <div key={slot} className="flex flex-col items-center gap-1.5">
              <div
                className={
                  'flex items-center justify-center overflow-hidden bg-black/5 text-[10px] text-slate-400 ' +
                  (slot === 'cover' ? 'h-20 w-20 rounded-2xl' : 'h-10 w-10 rounded-full')
                }
              >
                {asset ? <Preview asset={asset} /> : (slot === 'cover' ? '无封面' : '无头像')}
              </div>
              <button
                type="button"
                data-testid={`upload-${slot}`}
                disabled={!canUpload}
                onClick={() => ref.current?.click()}
                className="dsh-chip text-[11px] disabled:opacity-40"
              >
                {asset ? '更换' : '上传'}
              </button>
              <input
                ref={ref}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void pick(file, slot);
                }}
              />
            </div>
          );
        })}
      </div>
      {!canUpload && (
        <div className="mt-2 text-[11px] text-slate-400">
          登录后才能上传图片（已有的图片照常显示）。
        </div>
      )}
    </div>
  );
}

function Preview({ asset }: { asset: { mime: string; bytes: Uint8Array } }) {
  const url = useObjectUrl(asset);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null;
}

function useObjectUrl(asset: { mime: string; bytes: Uint8Array }): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const created = URL.createObjectURL(new Blob([asset.bytes as unknown as BlobPart], { type: asset.mime }));
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [asset]);
  return url;
}
