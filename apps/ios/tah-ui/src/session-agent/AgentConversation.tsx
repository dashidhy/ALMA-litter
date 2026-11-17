import { useEffect, useMemo, useState } from 'react';
import { Working } from '../components/Working';
import { WorkingLogPanel } from '../components/WorkingLogPanel';
import { workingDuration } from '../working';
import type { WorkingLog } from '../contract';
import type { ChatStyle } from '../chatStyle';
import type { AgentCall, AgentSnapshot } from './model';
import { AgentContent } from './AgentContent';
import { answers, groupTurns, liveTurn, publicEvents, workingSummary } from './turns';
import type { AgentTurnView, AgentWorkingLog } from './turns';

function TurnLog({ group, sessionId, call, close }: { group: AgentTurnView; sessionId: string; call: AgentCall; close: () => void }) {
  const [loaded, setLoaded] = useState<AgentWorkingLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const live = liveTurn(group.turn.status);
  const id = group.turn.id;
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await call<AgentWorkingLog>('agent.workingLog', { id });
        if (active && next.turn.id === id) { setLoaded(next); setError(null); }
      } catch { if (active) setError('工作记录暂时无法更新，已加载的内容仍保留。'); }
      if (active && live) timer = setTimeout(() => void read(), 1000);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [id, sessionId, call, live, retry]);
  const summary = workingSummary(group);
  const log: WorkingLog = { id, actionID: sessionId, position: group.position, revisionIndex: 0,
    startedAt: summary.startedAt, endedAt: summary.endedAt,
    events: loaded ? publicEvents(loaded.messages, loaded.activities, loaded.turn.status) : [],
    criticPassed: false, loading: !loaded && !error, failed: Boolean(error), limited: loaded?.limited ?? false,
    superseded: false, progressing: live, error,
  };
  return <WorkingLogPanel id={id} actionID={sessionId} log={log} caption={`第 ${group.position + 1} 轮`}
    pending={false} error={null} close={close} refresh={() => setRetry(value => value + 1)} />;
}

export function AgentConversation({ snapshot, call, style, openFile, openExternal }: {
  snapshot: AgentSnapshot; call: AgentCall; style: ChatStyle; openFile: (path: string) => void; openExternal: (url: string) => void;
}) {
  const groups = useMemo(() => groupTurns(snapshot), [snapshot]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedGroup = groups.find(group => group.turn.id === selected);
  return <section className="conversation" data-chat-style={style} aria-label="对话">
    <div className="section-heading"><h2>对话</h2></div>
    {!groups.length ? <div className="empty-state"><h2>围绕这份转写，持续工作。</h2><p>可以直接提问，也可以用下方 Skill 审查转写或生成笔记。</p></div> : null}
    <div className="chat-messages">{groups.map(group => {
      const summary = workingSummary(group);
      const reply = answers(group.messages, group.turn.status);
      const duration = workingDuration(summary.startedAt, summary.endedAt);
      return <div className="agent-turn" key={group.turn.id} data-turn-id={group.turn.turnId ?? group.turn.id}>
        <article className="chat-message message-user"><div className="message-content"><header className="message-byline">你</header>
          <AgentContent text={group.user.text || (group.user.skill ? `/${group.user.skill}` : '')} markdown={false} openFile={openFile} openExternal={openExternal} />
        </div></article>
        <article className="chat-message message-assistant"><span className="chat-avatar" aria-hidden="true">a</span><div className="message-content">
          <header className="message-byline"><span>Alma</span>{group.turn.status === 'completed' ? <span className="completion-label">{duration ? `Completed in ${duration}` : 'Completed'}</span> : null}</header>
          {reply.map(message => <AgentContent key={message.id} text={message.text} markdown={message.status !== 'streaming'} openFile={openFile} openExternal={openExternal} />)}
          {['failed', 'interrupted'].includes(group.turn.status) ? <p className="hint">{group.turn.status === 'failed' ? '本轮未完成' : '本轮已中断'}，已收到的过程和内容保留在工作记录中。</p> : null}
          <Working summary={summary} disabled={false} open={() => setSelected(group.turn.id)} />
        </div></article>
      </div>;
    })}</div>
    {selectedGroup ? <TurnLog key={`${snapshot.sessionId}:${selectedGroup.turn.id}`} group={selectedGroup} sessionId={snapshot.sessionId} call={call} close={() => setSelected(null)} /> : null}
  </section>;
}
