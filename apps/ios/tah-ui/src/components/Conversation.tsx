import type { ChatStyle } from '../chatStyle';
import type { MaterialRequest, Presentation, Revision, TimelineItem, WorkingSummary } from '../contract';
import type { UIController } from '../controller';
import { completedPhase, isGuardianPhase, workingDuration } from '../working';
import { Content } from './Content';
import { Icon } from './Icon';
import { Working } from './Working';

function RevisionFiles({ revision, actionID, disabled, read }: {
  revision: Revision; actionID: string; disabled: boolean; read: (request: MaterialRequest) => void;
}) {
  return <div className="revision-files" aria-label={`Revision v${revision.revisionIndex} materials`}>
    <button disabled={disabled} aria-label={`Read notes v${revision.revisionIndex}`} onClick={() => read({ kind: 'outcome', actionID, revisionIndex: revision.revisionIndex, file: 'structured-notes.md' })}><Icon name="document" />Notes <small>v{revision.revisionIndex}</small></button>
    <button disabled={disabled} aria-label={`Read ASR terms v${revision.revisionIndex}`} onClick={() => read({ kind: 'outcome', actionID, revisionIndex: revision.revisionIndex, file: 'suspicious-asr-terms.md' })}><Icon name="document" />ASR terms <small>v{revision.revisionIndex}</small></button>
  </div>;
}
function CompletionLabel({ summary }: { summary: WorkingSummary }) {
  const elapsed = workingDuration(summary.startedAt, summary.endedAt);
  return <span className="completion-label">{elapsed ? `Completed in ${elapsed}` : 'Completed'}</span>;
}
function Message({ item, revision, p, controller, disabled, read }: {
  item: TimelineItem; revision?: Revision; p: Presentation; controller: UIController;
  disabled: boolean; read: (request: MaterialRequest) => void;
}) {
  // Legacy startup fixtures get a neutral presentation. Titles never select roles.
  const role = item.role ?? 'system';
  const working = role === 'assistant' ? item.working : null;
  const completed = completedPhase(item.phase) || completedPhase(working?.phase);
  return <article className={`timeline-item chat-message message-${role}`} data-role={role}>
    {role === 'assistant' ? <span className="chat-avatar" aria-hidden="true">a</span> : null}
    <div className="message-content"><header className="message-byline"><span>{role === 'user' ? 'You' : role === 'assistant' ? 'Alma' : item.title}</span>
      {item.revisionIndex !== undefined ? <span>v{item.revisionIndex}</span> : null}
      {role === 'assistant' && completed ? working ? <CompletionLabel summary={working} /> : <span>Completed</span> : null}
    </header>
      {item.text ? <Content text={item.text} markdown={role !== 'user' && item.markdown} /> : null}
      {working ? <Working key={working.id} summary={completed ? { ...working, phase: 'completed', live: false } : working} disabled={disabled}
        open={() => { void controller.run('openWorkingLog', { actionID: p.editor!.actionID, position: working.position }); }} /> : null}
      {item.canExpand ? <button className="row-button" disabled={disabled || !p.permissions.loadHistory} onClick={() => { void controller.run('expandConversation', { actionID: p.editor!.actionID, itemID: item.id }); }}>Show full entry</button> : null}
      {revision ? <RevisionFiles revision={revision} actionID={p.editor!.actionID} disabled={disabled || !p.permissions.readMaterial} read={read} /> : null}
    </div>
  </article>;
}
export function Conversation({ p, controller, disabled, read, style }: {
  p: Presentation; controller: UIController; disabled: boolean; read: (request: MaterialRequest) => void; style: ChatStyle;
}) {
  const owners = new Map<number, string>();
  for (const item of p.timeline) {
    if (item.role === 'assistant' && item.revisionIndex !== undefined && (completedPhase(item.phase) || completedPhase(item.working?.phase))) owners.set(item.revisionIndex, item.id);
  }
  const activity = p.currentActivity;
  const showActivity = activity && !isGuardianPhase(activity.phase) && !p.timeline.some(item => item.working?.id === activity.id);
  return <section className="conversation" data-chat-style={style} aria-label="Conversation">
    <div className="section-heading"><h2>Conversation</h2><button className="icon-button" aria-label="Refresh action" disabled={disabled || p.isBusy} onClick={() => { void controller.run('refresh', {}); }}><Icon name="refresh" /></button></div>
    {p.hasMoreHistory ? <button className="row-button" disabled={disabled || !p.permissions.loadHistory} onClick={() => { void controller.run('loadMoreConversation', { actionID: p.editor!.actionID }); }}>Load earlier entries</button> : null}
    {!p.timeline.length && !activity ? <div className="empty-state"><h3>{p.canOmitInstructions ? 'Your first notes start here.' : 'Ready for your next revision.'}</h3><p>{p.canOmitInstructions ? 'Add a direction below, or send without instructions to create v0.' : 'Describe what you would like to change in the notes.'}</p></div> : null}
    <div className="chat-messages">{p.timeline.map(item => <Message key={item.id} item={item} p={p} controller={controller} disabled={disabled} read={read}
      revision={p.revisions.find(revision => owners.get(revision.revisionIndex) === item.id)} />)}
      {showActivity ? <article className="chat-message message-assistant current-working"><span className="chat-avatar" aria-hidden="true">a</span><div className="message-content">
        <header className="message-byline"><span>Alma</span><span>v{activity.revisionIndex}</span>{completedPhase(activity.phase) ? <CompletionLabel summary={activity} /> : null}</header>
        <Working key={activity.id} summary={activity} disabled={disabled} open={() => { void controller.run('openWorkingLog', { actionID: p.editor!.actionID, position: activity.position }); }} />
      </div></article> : null}
    </div>
    {p.revisions.filter(revision => !owners.has(revision.revisionIndex)).map(revision => <RevisionFiles key={revision.id} revision={revision} actionID={p.editor!.actionID} disabled={disabled || !p.permissions.readMaterial} read={read} />)}
  </section>;
}
