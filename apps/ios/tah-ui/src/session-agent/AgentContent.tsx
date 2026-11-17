import { memo, useMemo } from 'react';
import { createMarkdownRenderer, safeLink } from '../markdown';
import { businessLink, readableAssetMarkdown } from './model';

export const AgentContent = memo(function AgentContent({ text, markdown, sourcePath, openFile, openExternal }: {
  text: string; markdown: boolean; sourcePath?: string; openFile: (path: string) => void; openExternal: (url: string) => void;
}) {
  const render = useMemo(() => createMarkdownRenderer(href => {
    const file = businessLink(href, sourcePath);
    return file ? `https://alma.invalid/__asset/${encodeURIComponent(file)}` : safeLink(href);
  }), [sourcePath]);
  const html = useMemo(() => markdown ? render(readableAssetMarkdown(text, sourcePath)) : '', [text, markdown, render, sourcePath]);
  if (!markdown) return <div className="literal-text">{text}</div>;
  return <div className="markdown" onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    const internal = href.startsWith('https://alma.invalid/__asset/') ? href.slice('https://alma.invalid/__asset/'.length) : href;
    const file = businessLink(internal);
    if (file) openFile(file);
    else if (!href.startsWith('https://alma.invalid/')) { const url = safeLink(href); if (url) openExternal(url); }
  }} onAuxClick={event => { if (event.target instanceof Element && event.target.closest('a')) event.preventDefault(); }}
    onContextMenu={event => { if (event.target instanceof Element && event.target.closest('a')) event.preventDefault(); }}
    dangerouslySetInnerHTML={{ __html: html }} />;
});
