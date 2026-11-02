import { useRef, useState } from 'react';
import type { Presentation } from '../contract';
import type { UIController } from '../controller';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

export function Library({ p, controller, disabled, error, title, text, setTitle, setText, close }: {
  p: Presentation; controller: UIController; disabled: boolean; title: string; text: string;
  error: string | null; setTitle: (value: string) => void; setText: (value: string) => void; close: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileVersion = useRef(0);
  async function loadFile(file: File | undefined) {
    if (!file) return;
    const version = ++fileVersion.current;
    setReading(true); setFileError(null);
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('Use a UTF-8 text file no larger than 32 MB.');
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (version !== fileVersion.current) return;
      setText(contents);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, '').slice(0, 512));
    } catch (error) { if (version === fileVersion.current) setFileError(error instanceof Error ? error.message : 'Could not read this file.'); }
    finally { if (version === fileVersion.current) setReading(false); }
  }
  return <Sheet title="Transcript library" close={close}>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <div className="section-heading"><h3>Saved transcripts</h3><span className="hint">{p.transcripts.length}</span></div>
    <div className="library-list">{p.transcripts.map(transcript => <button className="library-row" key={transcript.id}
      disabled={disabled || !p.permissions.selectTranscript || !transcript.enabled} aria-current={p.transcriptID === transcript.id ? 'true' : undefined}
      onClick={async () => { if (await controller.run('selectTranscript', { id: transcript.id })) close(); }}>
      <Icon name="document" /><span>{transcript.title}</span><Icon name={p.transcriptID === transcript.id ? 'check' : 'chevron'} />
    </button>)}</div>
    {!p.transcripts.length ? <p className="hint">Your imported transcripts will appear here.</p> : null}
    <button className="row-button accent-text" aria-expanded={importing} onClick={() => setImporting(!importing)}><Icon name="plus" />Import full transcript</button>
    {importing ? <form className="import-form" onSubmit={async event => {
      event.preventDefault();
      if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) { setFileError('Transcript text must be no larger than 32 MB.'); return; }
      if (await controller.run('importTranscript', { title, text })) setImporting(false);
    }}>
      <p className="hint">Paste the complete text or choose a UTF-8 file. Importing saves it to your library; processing requires your consent.</p>
      <label className="field">Title <span className="hint">Optional</span><input value={title} maxLength={512} disabled={disabled || !p.permissions.importTranscript} onChange={e => setTitle(e.target.value)} /></label>
      <label className="file-button">Choose text file<input type="file" accept=".txt,.md,text/plain,text/markdown" disabled={disabled || reading || !p.permissions.importTranscript} onChange={e => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      {reading ? <p className="loading-line" role="status"><span className="spinner" aria-hidden="true" />Reading text file…</p> : null}
      <label className="field">Transcript text<textarea rows={8} value={text} spellCheck={false} disabled={disabled || reading || !p.permissions.importTranscript} onChange={e => { ++fileVersion.current; setText(e.target.value); }} /></label>
      <p className="hint">{text.length.toLocaleString()} characters · kept as literal text</p>
      {fileError ? <p className="error" role="alert">{fileError}</p> : null}
      <button className="primary full-width" type="submit" disabled={disabled || reading || !p.permissions.importTranscript || !text.trim()}>Import transcript</button>
      <p className="hint">The pasted text is retained here after import.</p>
    </form> : null}
  </Sheet>;
}
