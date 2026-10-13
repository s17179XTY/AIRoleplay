const HAN = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/;

export function estimateTokens(text: string): number {
  let han = 0;
  let other = 0;
  for (const ch of text) {
    if (HAN.test(ch)) han += 1;
    else other += 1;
  }
  return Math.ceil(han * 0.6 + other * 0.25);
}
