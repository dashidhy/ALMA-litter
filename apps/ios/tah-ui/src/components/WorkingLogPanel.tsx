import type { WorkingLog } from '../contract';
import { isPublicWorkingEvent, workingDuration } from '../working';
import { Sheet } from './Sheet';
import { CriticPassed, Progressing, WorkingEventRow } from './Working';
import { useEventLogScroll } from '../useEventLogScroll';

export function WorkingLogPanel({ id, actionID, log, pending, error, close, refresh }: {
  id: string; actionID: string; log: WorkingLog | null | undefined; pending: boolean; error: string | null;
  close: () => void; refresh: () => void;
}) {
  const selected = log?.id === id && log.actionID === actionID ? log : null;
  const duration = selected ? workingDuration(selected.startedAt, selected.endedAt) : null;
  const events = selected?.events.filter(isPublicWorkingEvent) ?? [];
  const { scrollRef, contentRef, atBottom, following, latest } = useEventLogScroll();
  return <Sheet title="Working events" close={close}>
    <section className="working-log-panel" aria-busy={selected?.loading ?? false}>
      {selected ? <p className="hint log-caption">v{selected.revisionIndex}{duration ? ` · Worked for ${duration}` : ''}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {!selected ? <p className="notice" role="status">This working log is no longer selected. Close this sheet and open it again.</p> : <>
        {selected.limited ? <p className="notice">Earlier activity was omitted by the log limit.</p> : null}
        {selected.superseded ? <p className="notice">This activity belongs to an earlier revision.</p> : null}
        {selected.failed || selected.error ? <div className="error" role="alert"><p>{selected.error || 'Could not update activity. The last loaded events are still shown.'}</p>
          <button className="row-button" disabled={pending || selected.loading} onClick={refresh}>Retry working log</button></div> : null}
        {selected.loading && !events.length && !selected.criticPassed ? <p className="loading-line" role="status"><span className="spinner" />Loading working events…</p> : null}
      </>}
      <div className="working-log-events" ref={scrollRef} data-following={following ? 'true' : undefined} role="region" aria-label="Public working events" tabIndex={0}>
        <div ref={contentRef}>
          {events.map(event => <WorkingEventRow key={event.id} event={event} />)}
          {selected?.criticPassed ? <CriticPassed /> : null}
          {selected?.progressing && !selected.superseded ? <Progressing /> : null}
          {selected && !events.length && !selected.loading && !selected.failed && !selected.progressing ? <p className="hint">No public working events are available.</p> : null}
        </div>
      </div>
      <footer className="working-log-footer"><button style={{ visibility: atBottom ? 'hidden' : 'visible' }} disabled={!events.length}
        onClick={() => { scrollRef.current?.focus({ preventScroll: true }); latest(); }}>Latest events</button></footer>
    </section>
  </Sheet>;
}
