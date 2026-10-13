import type { FieldMap } from './template';

export function collectFields(root: ParentNode): FieldMap {
  const out: FieldMap = {};
  const ensure = (name: string): { values: string[]; labels: string[] } => {
    out[name] = out[name] ?? { values: [], labels: [] };
    return out[name];
  };
  const nodes = root.querySelectorAll('[data-dsh-field]');
  nodes.forEach((el) => {
    const name = el.getAttribute('data-dsh-field') ?? '';
    if (!name) return;
    const type = el.getAttribute('data-dsh-type') ?? (el as HTMLInputElement).type ?? 'text';
    const value = el.getAttribute('data-dsh-value') ?? (el as HTMLInputElement).value ?? '';
    let label = el.getAttribute('data-dsh-label') ?? '';
    if (!label) {
      const holder = (el as Element).closest('label');
      if (holder) label = (holder.textContent ?? '').trim();
    }
    const field = ensure(name);
    if (type === 'checkbox' || (el as HTMLInputElement).type === 'checkbox') {
      if ((el as HTMLInputElement).checked) {
        field.values.push(value);
        field.labels.push(label || value);
      }
    } else if (type === 'radio' || (el as HTMLInputElement).type === 'radio') {
      if ((el as HTMLInputElement).checked) {
        field.values = [value];
        field.labels = [label || value];
      }
    } else if ((el as HTMLSelectElement).tagName === 'SELECT') {
      const select = el as HTMLSelectElement;
      const selected = select.options[select.selectedIndex];
      if (selected && selected.value) {
        field.values = [selected.value];
        field.labels = [selected.textContent?.trim() || selected.value];
      }
    } else {
      const v = (el as HTMLInputElement).value ?? '';
      if (v) {
        field.values = [v];
        field.labels = [label || v];
      }
    }
  });
  return out;
}

export function buildBridgeScript(): string {
  const collectSource = collectFields.toString();
  return [
    '(function(){',
    'var collect = ' + collectSource + ';',
    'function post(type, payload){ try { parent.postMessage({ __dsh: true, type: type, payload: payload }, "*"); } catch(e){} }',
    'function snapshot(){ post("dsh:fields", { fields: collect(document), height: document.documentElement.scrollHeight }); }',
    'window.addEventListener("message", function(ev){',
    '  var d = ev.data || {};',
    '  if (d.__dshCmd === "collect") snapshot();',
    '  if (d.__dshCmd === "init") post("dsh:ready", { title: document.title, height: document.documentElement.scrollHeight });',
    '});',
    'document.addEventListener("input", snapshot);',
    'document.addEventListener("change", snapshot);',
    'document.addEventListener("click", function(e){ var t = e.target; if (t && t.closest && t.closest("a")) e.preventDefault(); }, true);',
    'window.addEventListener("load", function(){ post("dsh:ready", { title: document.title, height: document.documentElement.scrollHeight }); snapshot(); });',
    'if (document.readyState === "complete") { post("dsh:ready", { title: document.title }); snapshot(); }',
    '})();',
  ].join('\n');
}

export const SANDBOX_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
].join('; ');

export function buildSrcdoc(html: string, bridge: string): string {
  const head = '<meta http-equiv="Content-Security-Policy" content="' + SANDBOX_CSP + '">' + '<script>' + bridge + '</' + 'script>';
  if (html.includes('</head>')) return html.replace('</head>', head + '</head>');
  if (html.includes('<body')) return html.replace('<body', head + '<body');
  return '<!doctype html><html><head>' + head + '</head><body>' + html + '</body></html>';
}
