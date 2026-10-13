import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'details', 'summary', 'plot', 'p', 'br', 'hr', 'span', 'div', 'b', 'i', 'em', 'strong',
  'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead',
  'tbody', 'tr', 'td', 'th', 'blockquote', 'code', 'pre', 'img', 'ruby', 'rt', 'small',
  'sub', 'sup', 'mark', 'del', 'ins',
];

const ALLOWED_ATTR = ['class', 'style', 'src', 'alt', 'colspan', 'rowspan', 'data-card'];

const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family',
  'text-align', 'text-decoration', 'text-shadow', 'line-height', 'letter-spacing',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-color', 'border-style', 'border-width', 'border-radius', 'opacity',
  'width', 'height', 'max-width', 'display', 'gap', 'flex', 'flex-direction', 'align-items',
]);

const DANGEROUS_VALUE = /(url\s*\(|expression\s*\(|javascript:|position\s*:\s*fixed|z-index)/i;

let hookInstalled = false;

function installHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'style') return;
    const kept = (data.attrValue || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((decl) => {
        const idx = decl.indexOf(':');
        if (idx < 0) return false;
        const prop = decl.slice(0, idx).trim().toLowerCase();
        const value = decl.slice(idx + 1).trim();
        if (!SAFE_STYLE_PROPS.has(prop)) return false;
        if (prop === 'display' && !/^(block|inline|inline-block|flex|grid|none)$/.test(value)) return false;
        return !DANGEROUS_VALUE.test(decl);
      });
    if (kept.length === 0) data.keepAttr = false;
    else data.attrValue = kept.join('; ');
  });
}

export function sanitizeHtml(html: string): string {
  installHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcdoc'],
  });
}
