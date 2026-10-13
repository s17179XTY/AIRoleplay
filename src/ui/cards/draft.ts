import type { CardPackage } from '../../core/cards/package';
import { findText } from '../../core/cards/package';
import {
  emptyCardJson, parseRegexFile, parseWorldbookFile,
  type DshCardJson, type RegexScriptJson,
} from '../../core/cards/spec';
import type { WbEntryInput } from '../../core/assembler/types';

export interface CardDraft {
  json: DshCardJson;
  worldbook: WbEntryInput[];
  regex: RegexScriptJson[];
  uiHtml: string;
  template: string;
}

export function packageToDraft(pkg: CardPackage): CardDraft {
  let worldbook: WbEntryInput[] = [];
  let regex: RegexScriptJson[] = [];
  const wbText = findText(pkg, pkg.json.worldbook);
  if (wbText) {
    try {
      worldbook = parseWorldbookFile(wbText);
    } catch {
      worldbook = [];
    }
  }
  const rxText = findText(pkg, pkg.json.regex);
  if (rxText) {
    try {
      regex = parseRegexFile(rxText);
    } catch {
      regex = [];
    }
  }
  return {
    json: JSON.parse(JSON.stringify(pkg.json)) as DshCardJson,
    worldbook,
    regex,
    uiHtml: pkg.json.ui?.entry ? findText(pkg, pkg.json.ui.entry) ?? '' : '',
    template: findText(pkg, pkg.json.promptTemplate) ?? '',
  };
}

export function draftToPackage(draft: CardDraft, base: CardPackage): CardPackage {
  const json: DshCardJson = JSON.parse(JSON.stringify(draft.json));
  const texts = base.texts.filter(
    (t) => t.path !== json.worldbook && t.path !== json.regex
      && t.path !== json.ui?.entry && t.path !== json.promptTemplate,
  );

  if (draft.worldbook.length > 0) {
    json.worldbook = 'worldbook.json';
    texts.push({ path: 'worldbook.json', text: JSON.stringify({ version: 1, entries: draft.worldbook }, null, 2) });
  } else {
    delete json.worldbook;
  }

  if (draft.regex.length > 0) {
    json.regex = 'regex.json';
    texts.push({ path: 'regex.json', text: JSON.stringify({ version: 1, scripts: draft.regex }, null, 2) });
  } else {
    delete json.regex;
  }

  if (draft.uiHtml.trim()) {
    json.ui = { entry: 'ui/index.html', autoOpen: json.ui?.autoOpen ?? true };
    texts.push({ path: 'ui/index.html', text: draft.uiHtml });
  } else {
    delete json.ui;
  }

  if (draft.template.trim()) {
    json.promptTemplate = 'prompt.template.md';
    texts.push({ path: 'prompt.template.md', text: draft.template });
  } else {
    delete json.promptTemplate;
  }

  return { json, texts, assets: base.assets };
}

export function newWorldbookEntry(index: number): WbEntryInput {
  return {
    id: 'wb-' + Date.now().toString(36) + '-' + index,
    keys: [], secondaryKeys: [], content: '', constant: false, selective: false,
    position: 'before-char', order: index, depth: 4, recursive: false, enabled: true,
  };
}

export function newRegexScript(index: number): RegexScriptJson {
  return {
    id: 'rx-' + Date.now().toString(36) + '-' + index,
    name: '规则 ' + (index + 1), pattern: '', flags: 'g', replacement: '',
    enabled: true, order: index, target: 'display',
  };
}

export { emptyCardJson };
