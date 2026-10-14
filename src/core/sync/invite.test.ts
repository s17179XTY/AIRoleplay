import { describe, it, expect } from 'vitest';
import { canonicalInviteCode } from './invite';

describe('invite code canonicalization', () => {
  it('標準形式的碼正規化後不變（幂等）', () => {
    const code = 'INV-GPAP-RMAA-MXKX';
    expect(canonicalInviteCode(code)).toBe(code);
  });

  it('全小寫、沒有破折號、夾帶空白都能還原成正規形式', () => {
    expect(canonicalInviteCode('invgpaprmaamxkx')).toBe('INV-GPAP-RMAA-MXKX');
    expect(canonicalInviteCode('INV GPAP RMAA MXKX')).toBe('INV-GPAP-RMAA-MXKX');
    expect(canonicalInviteCode('  inv-gpap-rmaa-mxkx  ')).toBe('INV-GPAP-RMAA-MXKX');
    expect(canonicalInviteCode('INVGPAPRMAA MXKX')).toBe('INV-GPAP-RMAA-MXKX');
  });

  it('從聊天軟體複製時常見的全角字元也收斂', () => {
    expect(canonicalInviteCode('ＩＮＶ－ＧＰＡＰ－ＲＭＡＡ－ＭＸＫＸ')).toBe('INV-GPAP-RMAA-MXKX');
  });

  it('貼上整段訊息時只取英數字（不會把中文一起吃進去）', () => {
    expect(canonicalInviteCode('邀請碼：INV-GPAP-RMAA-MXKX 請收好')).toBe('INV-GPAP-RMAA-MXKX');
  });

  it('打錯字元不會被「修好」——錯的還是錯的（該拒絕就要拒絕）', () => {
    expect(canonicalInviteCode('INV-GPAP-RMAA-MXKK')).toBe('INV-GPAP-RMAA-MXKK');
    expect(canonicalInviteCode('INV-GPAP-RMAA-MXKK')).not.toBe('INV-GPAP-RMAA-MXKX');
  });
});
