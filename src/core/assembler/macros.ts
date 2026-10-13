import type { MacroContext } from './types';

export function applyMacros(text: string, ctx: MacroContext): string {
  return text.replace(/\{\{\s*(user|char|persona|date|time|weekday)\s*\}\}/g, (matched, key: string) => {
    const value = (ctx as unknown as Record<string, string>)[key];
    return value ?? matched;
  });
}
