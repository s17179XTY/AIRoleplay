import type { ChatRequest, ProviderAdapter, ProviderConfig, StreamEvent } from './types';

export interface MockOptions { chunkSize?: number; delayMs?: number; }

export function createMockAdapter(script: string, opts: MockOptions = {}): ProviderAdapter {
  const chunkSize = opts.chunkSize ?? 12;
  const delayMs = opts.delayMs ?? 30;
  return {
    id: 'mock',
    async listModels() {
      return ['mock-model'];
    },
    async *streamChat(_cfg: ProviderConfig, _req: ChatRequest): AsyncGenerator<StreamEvent> {
      yield { type: 'reasoning', delta: '（mock 思考：按卡片格式生成状态栏与选项）' };
      for (let i = 0; i < script.length; i += chunkSize) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        yield { type: 'text', delta: script.slice(i, i + chunkSize) };
      }
      yield { type: 'usage', inputTokens: 800, outputTokens: Math.ceil(script.length / 2) };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

export function mockReplyFor(userInput: string, cardName: string): string {
  const option = userInput.trim().slice(0, 12) || '继续';
  return [
    '<details><summary>📅状况</summary>🌍世界：现代都市日常<br>',
    '⏰时间：2026年10月13日 星期二 傍晚<br>',
    '🏘️地点：教学楼三楼走廊<br>',
    '📖剧情：回应「' + option + '」之后的推进</details>',
    '<plot>你把话说完，走廊尽头的风把窗户吹得轻轻响了一声。对面的男人喉结滚动了一下，手在运动裤两侧搓了搓，',
    '挤出一个比哭还难看的笑。你盯着他的眼睛，能听见他脑子里那些乱七八糟的念头一条一条往外冒，像锅里翻了的水。</plot>',
    '<details><summary>🕶自己</summary>🎯信息：苏小染 / 女 / 高三学生 / 校花<br>',
    '👕装束：奶白色针织开衫 / 浅粉色圆领T恤 / 卡其色百褶裙 / 白色帆布鞋</details>',
    '<details><summary>💃张强</summary>💓信息：体育老师 / 外表粗犷<br>',
    '🧠想法：她到底想干什么？</details>',
    '<details><summary>近期记忆</summary>当前记忆数目：1/4<br>[1]（2026-10-13 傍晚）' + cardName + '继续追问，张强慌乱。</details>',
    '<hr class="separator">',
    '<p>👉选项：</p>',
    '<p>A. 逼近一步，压低声音继续施压</p>',
    '<p>B. 转身走开，把这件事先放一放</p>',
    '<p>C. 掏出手机，做出要打电话的样子</p>',
  ].join('\n');
}
