import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Content } from '../components/Content';
import { renderMarkdown, safeLink } from '../markdown';

describe('material rendering boundary', () => {
  it('renders headings, nested lists, GFM tables, links, checklists and code', () => {
    const document = new DOMParser().parseFromString(renderMarkdown('# Title\n\n## Decisions\n\n- First\n  - Nested\n\n| Term | Meaning |\n| --- | --- |\n| ASR | Speech recognition |\n\n```ts\nconst text = "<script>literal</script>";\n```\n\n[Reference](https://example.com)\n\n- [x] Done'), 'text/html');
    expect(document.querySelector('h1')?.textContent).toBe('Title');
    expect(document.querySelector('h2')?.textContent).toBe('Decisions');
    expect(document.querySelector('ul ul li')?.textContent).toBe('Nested');
    expect(document.querySelector('.table-scroll table td')?.textContent).toBe('ASR');
    expect(document.querySelector('pre[tabindex="0"] code')?.textContent).toContain('<script>literal</script>');
    expect(document.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(document.querySelector('input[disabled][checked]')).not.toBeNull();
  });
  it('prevents active HTML, remote images and unsafe protocols', () => {
    const html = renderMarkdown('<img src="https://evil.example/pixel" onerror="alert(1)">\n<script>alert(2)</script>\n\n![pixel](https://evil.example/pixel)\n\n[script](javascript:alert%281%29) [data](data:text/html,evil) [local](file:///secret) [ipc](ipc://host) [relative](/api)');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelector('img,script,iframe,svg,style,object,[onerror],[src],a')).toBeNull();
    expect(parsed.body.textContent).toContain('[Image: pixel]');
  });
  it.each(['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/plain,hi', 'file:///x', 'ipc://native', '//remote/x', '/local', 'https://example.com/\nattack', 'mailto:hello@example.com', 'https://user:secret@example.com', 'https://user@example.com'])('rejects link %s', href => expect(safeLink(href)).toBeNull());
  it.each(['https://example.com/a', 'http://example.com'])('allows safe link %s', href => expect(safeLink(href)).not.toBeNull());
  it('keeps unflagged source and user instructions literal', () => {
    const markup = renderToStaticMarkup(<Content text={'# Raw\n**not bold** <img src="remote">'} markdown={false} />);
    expect(markup).not.toContain('<h1>');
    expect(markup).not.toContain('<strong>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img');
  });
});
