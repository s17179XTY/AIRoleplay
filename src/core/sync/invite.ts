/**
 * 邀請碼的正規化（**與 `worker/src/invite.ts` 是同一套規則，改一邊要改兩邊**）。
 *
 * 手抄邀請碼太容易出錯（大小寫、漏了破折號、從聊天軟體複製時夾帶空白或全角字元），
 * 而資料庫存的是 `sha256(碼)`——少一個字元就完全對不上。所以在送出前先統一成正規形式：
 *   1. NFKC 正規化（全角 `ＩＮＶ－` 收斂成半角 `INV-`）
 *   2. 全部轉大寫、只留英數字（去掉空白、破折號、任何標點與中文）
 *   3. 去掉開頭的 `INV` 之後，每 4 個字元補一個破折號
 *
 * 產生器本來就產生 `INV-XXXX-XXXX-XXXX`，所以對正確的碼來說這個函式是幂等的
 * （正規化後的字串與原本完全相同，送到伺服器的雜湊也就一模一樣）。
 */
export function canonicalInviteCode(input: string): string {
  const compact = input.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const payload = compact.startsWith('INV') ? compact.slice(3) : compact;
  const groups = payload.match(/.{1,4}/g) ?? [];
  return ['INV', ...groups].join('-');
}
