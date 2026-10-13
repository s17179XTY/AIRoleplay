export interface FieldValue { values: string[]; labels: string[]; }
export type FieldMap = Record<string, FieldValue>;

export interface TemplateContext {
  fields: FieldMap;
  scenario: string;
  persona: string;
  cardName: string;
  user: string;
  date: string;
  time: string;
}

const FIELD_RE = /\{\{\s*f:([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*((?:\|[^}]*)?)\}\}/g;
const COND_RE = /\{\{\s*\?([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*\}\}([\s\S]*?)\{\{\s*\/\1\s*\}\}/g;

export function renderTemplate(template: string, ctx: TemplateContext): string {
  let out = template.replace(COND_RE, (_m, name: string, body: string) => {
    const field = ctx.fields[name];
    return field && field.values.length > 0 ? body : '';
  });

  out = out.replace(FIELD_RE, (_m, name: string, opts: string) => {
    const field = ctx.fields[name];
    if (!field) return '';
    const useRaw = /(^|\|)\s*raw\s*(\||$)/.test(opts);
    const sepMatch = /\|\s*sep=([^|]*)/.exec(opts);
    const sep = sepMatch ? sepMatch[1] : '、';
    const list = useRaw ? field.values : field.labels.map((l, i) => l || field.values[i] || '');
    return list.filter(Boolean).join(sep);
  });

  const macros: Record<string, string> = {
    scenario: ctx.scenario,
    persona: ctx.persona,
    char: ctx.cardName,
    user: ctx.user,
    date: ctx.date,
    time: ctx.time,
  };
  out = out.replace(/\{\{\s*(scenario|persona|char|user|date|time)\s*\}\}/g, (_m, key: string) => macros[key] ?? '');

  return out.replace(/\n{3,}/g, '\n\n').trim();
}
