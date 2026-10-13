import { seedDemoCard } from './seed';
import { emptyCardJson, DEFAULT_MEMORY, type DshCardJson } from '../cards/spec';
import type { CardPackage } from '../cards/package';
import { CARD_SPEC } from '../cards/spec';

export function seedPackage(): CardPackage {
  const demo = seedDemoCard();
  const json: DshCardJson = {
    ...emptyCardJson(demo.record.name),
    id: demo.record.id,
    author: demo.record.author,
    version: demo.record.version,
    description: demo.record.description,
    tags: demo.record.tags,
    prompts: { ...demo.prompts },
    persona: { name: '{{user}}', gender: '', intro: demo.persona },
    scenario: demo.scenario,
    firstMessage: demo.firstMessage,
    mesExample: '',
    worldbook: 'worldbook.json',
    memory: { ...DEFAULT_MEMORY, ...demo.memory },
    ui: { entry: 'ui/index.html', autoOpen: true },
    promptTemplate: 'prompt.template.md',
  };
  const texts: CardPackage['texts'] = [
    { path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: demo.worldbook }, null, 2) },
    { path: 'ui/index.html', text: seedUiHtml() },
    { path: 'prompt.template.md', text: seedTemplate() },
  ];
  const assets: CardPackage['assets'] = [{ path: 'assets/cover.svg', mime: 'image/svg+xml', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0072E3"/></svg>') }];
  json.cover = 'assets/cover.svg';
  return { json, texts, assets };
}

function seedUiHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8"><style>',
    'body{font-family:-apple-system,"PingFang SC",sans-serif;margin:0;padding:12px;background:#fff;color:#1c1c1e}',
    'h2{font-size:15px;margin:0 0 8px}',
    'fieldset{border:1px solid #e5e5ea;border-radius:12px;margin:0 0 10px;padding:8px 10px}',
    'legend{font-size:12px;color:#0072E3;padding:0 4px}',
    'label{display:block;font-size:13px;padding:5px 0}',
    'input[type=text]{width:100%;box-sizing:border-box;padding:8px;border:1px solid #e5e5ea;border-radius:8px;font-size:13px}',
    '</style></head><body>',
    '<h2>XP 偏好选择（演示）</h2>',
    '<fieldset><legend>第一类：世界观</legend>',
    '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A01" data-dsh-label="校园日常"> 校园日常</label>',
    '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A02" data-dsh-label="雨夜都市"> 雨夜都市</label>',
    '</fieldset>',
    '<fieldset><legend>第二类：角色</legend>',
    '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B01" data-dsh-label="读心能力"> 读心能力</label>',
    '<label><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B02" data-dsh-label="意念操控"> 意念操控</label>',
    '</fieldset>',
    '<label>主人公姓名<input type="text" data-dsh-field="userName" data-dsh-type="text" placeholder="留空则用「我」"></label>',
    '<label>补充设定<input type="text" data-dsh-field="extra" data-dsh-type="text" placeholder="可选"></label>',
    '</body></html>',
  ].join('\n');
}

function seedTemplate(): string {
  return [
    '【初始信息设定】',
    '',
    '【全局XP】',
    '用户选择的偏好：{{f:xp}}',
    '{{?userName}}主人公姓名：{{f:userName}}{{/userName}}',
    '{{?extra}}补充设定：{{f:extra}}{{/extra}}',
    '',
    '【世界观】',
    '请根据上面的偏好生成一个合理真实的世界观。',
    '',
    '【前情提要】',
    '{{scenario}}',
  ].join('\n');
}

export { CARD_SPEC };
