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

  const cover = pkg.assets.find((a) => a.path === (pkg.json.cover ?? 'assets/cover.png'));
  const avatarAsset = pkg.assets.find((a) => a.path === (pkg.json.avatar ?? 'assets/avatar.png'));

  return (
    <div className="dsh-card p-3.5">
      <div className="mb-2.5 text-[12px] text-slate-500">卡片图片</div>

      {/* 封面：整行的大图，像一张卡 */}
      <div className="relative overflow-hidden rounded-2xl bg-black/5" style={{ aspectRatio: '16 / 10' }}>
        {cover ? (
          <Preview asset={cover} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-slate-400">还没有封面</div>
        )}
        <button
          type="button"
          data-testid="upload-cover"
          disabled={!canUpload}
          onClick={() => coverRef.current?.click()}
          className="absolute bottom-2 right-2 rounded-full bg-[rgba(20,24,33,0.72)] px-3.5 py-1.5 text-[12px] text-white backdrop-blur disabled:opacity-40"
        >
          {cover ? '更换封面' : '上传封面'}
        </button>
      </div>

      {/* 头像：小圆 */}
      <div className="mt-3 flex items-center gap-3">
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-black/5">
          {avatarAsset ? (
            <Preview asset={avatarAsset} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">无</div>
          )}
        </div>
        <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-400">
          头像显示在聊天气泡旁边
        </div>
        <button
          type="button"
          data-testid="upload-avatar"
          disabled={!canUpload}
          onClick={() => avatarRef.current?.click()}
          className="dsh-chip shrink-0 text-[11px] disabled:opacity-40"
        >
          {avatarAsset ? '更换' : '上传'}
        </button>
      </div>

      <input
        ref={coverRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void pick(file, 'cover');
        }}
      />
      <input
        ref={avatarRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void pick(file, 'avatar');
        }}
      />

      {!canUpload && (
        <div className="mt-2 text-[11px] text-slate-400">
          登录后才能上传图片（已有的图片照常显示）。
        </div>
      )}
    </div>
  );
}

function Preview({ asset, className }: { asset: { mime: string; bytes: Uint8Array }; className?: string }) {
  const url = useObjectUrl(asset);
  return url ? <img src={url} alt="" className={className} /> : null;
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
