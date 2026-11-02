import { memo, useMemo, useState } from 'react';
import { renderMarkdown, safeLink } from '../markdown';
import { call } from '../bridge';

export const Content = memo(function Content({ text, markdown = false }: { text: string; markdown?: boolean }) {
  const html = useMemo(() => markdown ? renderMarkdown(text) : '', [text, markdown]);
  const [error, setError] = useState<string | null>(null);
  if (!markdown) return <div className="literal-text">{text}</div>;
  return <><div className="markdown" onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    event.preventDefault();
    const url = safeLink(anchor.getAttribute('href') || '');
    if (event.nativeEvent.isTrusted && url) {
      setError(null);
      void call('openExternal', { url }).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not open the link.'));
    }
  }} onAuxClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (anchor) event.preventDefault();
  }} onContextMenu={event => {
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
  }} dangerouslySetInnerHTML={{ __html: html }} />{error ? <p className="error" role="alert">{error}</p> : null}</>;
});
