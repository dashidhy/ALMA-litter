import type { MaterialRequest, OutcomeFile, Presentation } from '../contract';
import { materialMatchesRequest } from '../material';
import { Content } from './Content';
import { Icon } from './Icon';

export interface Reading { request: MaterialRequest; materialID: string | null }
export function Reader({ p, reading, disabled, read, close }: {
  p: Presentation; reading: Reading; disabled: boolean; read: (request: MaterialRequest) => void; close: () => void;
}) {
  const material = p.material?.id === reading.materialID && materialMatchesRequest(p.material, reading.request) ? p.material : null;
  const raw = reading.request.kind === 'rawTranscript';
  const revision = p.revisions.find(revision => revision.revisionIndex === reading.request.revisionIndex);
  const latest = p.revisions.at(-1);
  const choose = (kind: MaterialRequest['kind'], file: OutcomeFile) => {
    const index = reading.request.revisionIndex ?? latest?.revisionIndex ?? null;
    if (kind === 'rawTranscript') read({ actionID: reading.request.actionID, kind, file: null, revisionIndex: null });
    else if (index !== null) read({ actionID: reading.request.actionID, kind, file, revisionIndex: index });
  };
  return <section className="reader-page">
    <header className="app-header"><button className="icon-button" aria-label="Back to action" disabled={disabled} onClick={close}><Icon name="back" /></button><h1>{raw ? 'Raw transcript' : 'Structured Notes'}</h1><span className="header-mark">alma</span></header>
    <div className="reader-controls">
      <div className="reader-tabs" role="group" aria-label="Reading material">
        <button aria-pressed={!raw && reading.request.file === 'structured-notes.md'} disabled={disabled || !p.permissions.readMaterial || !latest} onClick={() => choose('outcome', 'structured-notes.md')}>Notes</button>
        <button aria-pressed={!raw && reading.request.file === 'suspicious-asr-terms.md'} disabled={disabled || !p.permissions.readMaterial || !latest} onClick={() => choose('outcome', 'suspicious-asr-terms.md')}>ASR terms</button>
        <button aria-pressed={raw} disabled={disabled || !p.permissions.readMaterial} onClick={() => choose('rawTranscript', 'structured-notes.md')}>Transcript</button>
      </div>
      {!raw ? <label className="revision-picker">Revision<select aria-label="Read revision" value={reading.request.revisionIndex ?? ''} disabled={disabled || !p.permissions.readMaterial}
        onChange={e => { if (reading.request.kind === 'outcome') read({ ...reading.request, revisionIndex: Number(e.target.value) }); }}>
        {p.revisions.map(revision => <option key={revision.id} value={revision.revisionIndex}>v{revision.revisionIndex}{revision.id === latest?.id ? ' · Latest' : ''}</option>)}
      </select></label> : null}
    </div>
    <div className="material-scroll" key={material?.id ?? 'waiting'} tabIndex={0} aria-label="Material content" aria-busy={material?.isLoading ?? false}>
      <article className="material-content">
        <div className="material-heading"><p className="eyebrow">{raw ? 'TRANSCRIPT' : reading.request.file === 'suspicious-asr-terms.md' ? 'ASR REVIEW' : 'NOTES'}</p>
          <h2>{material?.title ?? (raw ? 'Raw transcript' : 'Reading material')}</h2>
          {revision && !raw ? <p className="hint configuration">{revision.configurationLabel}</p> : null}
        </div>
        {material?.isLoading ? <p className="loading-line" role="status"><span className="spinner" />Loading material…</p> : null}
        {material?.error ? <div className="error" role="alert"><p>{material.error}</p><button className="row-button" disabled={disabled || !p.permissions.readMaterial} onClick={() => read(reading.request)}>Try again</button></div> : null}
        {material?.text != null ? <Content text={material.text} markdown={material.markdown} /> : null}
        {material && !material.isLoading && !material.error && !material.text ? <p className="hint">This material is empty.</p> : null}
      </article>
    </div>
  </section>;
}
