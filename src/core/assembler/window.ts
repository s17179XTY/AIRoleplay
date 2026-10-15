/**
 * 上下文窗口：算出「窗口内」与「窗口外」，而且**边界永远不切开一个交换**。
 *
 * 规则来自 spec §1.3（使用者逐条确认过）：
 * - 一个「交换」= 一条用户输入 + 它后面紧跟的那条 AI 回复。
 * - 开场白（世界线第一条、没有对应用户输入的 assistant）自成完整单位。
 * - 未完成的交换（用户发了、AI 还没回）算一个 incomplete 单位；因为窗口以「完整交换」
 *   为单位对齐，它不会被挤出窗口 —— 这就是「绝不压半对」。
 * - **向外扩**：朴素切点若落在交换中间，把**整个交换**都算窗口外（而不是把半条拉回窗口内）。
 * - recent 模式至少保留最后一个完整交换（不能出现「窗口是空的」）。
 * - all 模式只认 `keptIds`（assemble 实际保留的历史）：**交换的第一条被保留才算窗口内**，
 *   否则整对都算窗口外 —— 这样才不会出现「既没进提示词、又没进摘要」的黑洞。
 */

export interface WindowMessage {
  id: string;
  role: 'user' | 'assistant';
}

export interface Exchange {
  ids: string[];
  complete: boolean;
}

export function buildExchanges(messages: WindowMessage[]): Exchange[] {
  const out: Exchange[] = [];
  let open: Exchange | null = null;

  for (const m of messages) {
    if (m.role === 'user') {
      if (open) {
        // 连续的用户消息（例如上一次生成被停止）：併进同一个未完成交换
        open.ids.push(m.id);
      } else {
        open = { ids: [m.id], complete: false };
        out.push(open);
      }
      continue;
    }
    if (open) {
      open.ids.push(m.id);
      open.complete = true;
      open = null;
      continue;
    }
    out.push({ ids: [m.id], complete: true });
  }

  return out;
}

export function computeWindow(input: {
  messages: WindowMessage[];
  mode: 'recent' | 'all';
  limit: number;
  /** 只在 all 模式用到：assemble 预算裁剪后实际保留的历史 id */
  keptIds?: Set<string>;
}): { windowIds: string[]; outsideIds: string[] } {
  const { messages, mode, limit, keptIds } = input;
  if (messages.length === 0) return { windowIds: [], outsideIds: [] };

  const exchanges = buildExchanges(messages);
  // 每条消息属于第几个交换
  const exOf: number[] = [];
  for (let i = 0; i < exchanges.length; i += 1) {
    for (let k = 0; k < exchanges[i].ids.length; k += 1) exOf.push(i);
  }
  const startOf = (exIdx: number) => {
    let s = 0;
    for (let i = 0; i < exIdx; i += 1) s += exchanges[i].ids.length;
    return s;
  };

  let cutEx: number;
  if (mode === 'recent') {
    const naive = Math.max(0, messages.length - Math.max(0, limit));
    let e = naive >= messages.length ? exchanges.length : exOf[naive];
    // 向外扩：切点落在交换中间时，把整个交换推到窗口外
    while (e < exchanges.length && startOf(e) < naive) e += 1;
    // 至少保留最后一个完整交换（limit 很小也不能把最新一轮也压掉）
    if (e >= exchanges.length) e = Math.max(0, exchanges.length - 1);
    cutEx = e;
  } else {
    cutEx = exchanges.length;
    for (let i = 0; i < exchanges.length; i += 1) {
      if (keptIds?.has(exchanges[i].ids[0])) {
        cutEx = i;
        break;
      }
    }
  }

  const windowIds: string[] = [];
  const outsideIds: string[] = [];
  exchanges.forEach((ex, i) => {
    if (i < cutEx) outsideIds.push(...ex.ids);
    else windowIds.push(...ex.ids);
  });

  return { windowIds, outsideIds };
}
