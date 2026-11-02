import { useEffect, useState } from 'react';
import type { WorkingEvent, WorkingSummary } from '../contract';
import { completedPhase, isPublicWorkingEvent, workingDuration } from '../working';
import { Icon } from './Icon';

export function WorkingEventRow({ event }: { event: WorkingEvent }) {
  return <div className="working-event" data-event-id={event.id}>
    <header><span className="event-mark" aria-hidden="true">{event.status === 'completed' || event.status === 'pass' ? '✓' : '·'}</span><strong>{event.title}</strong>
      {event.status ? <small>{event.status}</small> : null}</header>
    {event.round === 1 ? <small className="hint">Automatic correction</small> : null}
    {event.detail ? <p className="event-detail">{event.detail}</p> : null}
    {event.detailTruncated ? <small className="hint">Preview — open the full working log for complete text.</small> : null}
  </div>;
}
export function Progressing() {
  return <p className="working-progress" role="status"><span className="spinner" />Progressing…</p>;
}
export function CriticPassed() {
  return <p className="critic-passed"><Icon name="check" />Rule Critic · Passed</p>;
}
function Elapsed({ summary }: { summary: WorkingSummary }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!summary.live || !Number.isFinite(Date.parse(summary.startedAt ?? ''))) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [summary.live, summary.startedAt]);
  const duration = workingDuration(summary.startedAt, summary.live ? now : summary.endedAt);
  return <span>{duration ? `${summary.live ? 'Elapsed' : 'Worked for'} ${duration}` : 'Working events'}</span>;
}
export function Working({ summary, disabled, open }: { summary: WorkingSummary; disabled: boolean; open: () => void }) {
  const [expanded, setExpanded] = useState(summary.live);
  const fullLog = summary.canOpen ? <button className="working-log-link" disabled={disabled} onClick={open}>View full working events<Icon name="chevron" /></button> : null;
  // Completed publications never retain a disclosure or an inline event summary.
  if (completedPhase(summary.phase)) return fullLog;
  const events = summary.events.filter(isPublicWorkingEvent);
  const recent = summary.live ? events.slice(-3) : events;
  return <details className="working-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><Elapsed summary={summary} /><Icon name="chevron" /></summary>
    <div className="working-preview">{recent.map(event => <WorkingEventRow key={event.id} event={event} />)}
      {summary.criticPassed ? <CriticPassed /> : null}
      {summary.live && summary.progressing ? <Progressing /> : null}
      {fullLog}
    </div>
  </details>;
}
