import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function safeLink(href: string): string | null {
  // Match native openExternal: absolute HTTP(S), no embedded credentials.
  if (/[\u0000-\u0020\u007f]/.test(href) || !/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const parser = new Marked({ gfm: true, breaks: false, renderer: {
  // Escape source HTML before parsing it into any DOM, preventing embedded resource loads.
  html({ text }) { return escape(text); },
  image({ text }) { return `<span>[Image: ${escape(text || 'omitted')}]</span>`; },
  code({ text }) { return `<pre tabindex="0" role="region" aria-label="Code"><code>${escape(text)}</code></pre>`; },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const url = safeLink(href);
    return url ? `<a href="${escape(url)}"${title ? ` title="${escape(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  },
  table(token) {
    const head = token.header.map(cell => this.tablecell(cell)).join('');
    const rows = token.rows.map(row => `<tr>${row.map(cell => this.tablecell(cell)).join('')}</tr>`).join('');
    return `<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  },
} });

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(parser.parse(text, { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote',
      'pre', 'code', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'role', 'aria-label', 'tabindex', 'type', 'checked', 'disabled', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['tabindex', 'target', 'rel', 'type', 'checked', 'disabled', 'start', 'align'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}
