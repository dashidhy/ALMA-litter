import type { WorkingEvent, WorkingSummary } from '../contract';
import type { AgentActivity, AgentMessage, AgentSnapshot, AgentTurn } from './model';
import { workingPreview } from './presentation';

export interface AgentTurnView {
  user: AgentMessage; turn: AgentTurn; position: number;
  messages: AgentMessage[]; activities: AgentActivity[];
}
export interface AgentWorkingLog { turn: AgentTurn; messages: AgentMessage[]; activities: AgentActivity[]; limited: boolean }
export const liveTurn = (status: string) => status === 'sending' || status === 'running' || status === 'inProgress';
const iso = (ms: number | null) => ms == null ? null : new Date(ms).toISOString();

export function groupTurns(snapshot: AgentSnapshot): AgentTurnView[] {
  const users = snapshot.messages.filter(message => message.role === 'user');
  const groups = users.map((user, position): AgentTurnView => ({ user, position, messages: [], activities: [],
    turn: snapshot.turns?.find(turn => turn.id === user.id) ?? {
      id: user.id, turnId: user.turnId ?? null, startedAtMs: null, endedAtMs: null,
      status: position === users.length - 1 ? (snapshot.busy ? 'running' : snapshot.status || 'completed') : 'completed',
    },
  }));
  const byUser = new Map(groups.map(group => [group.user.id, group]));
  const byNative = new Map(groups.filter(group => group.turn.turnId).map(group => [group.turn.turnId!, group]));
  let current: AgentTurnView | undefined;
  for (const message of snapshot.messages) {
    if (message.role === 'user') current = byUser.get(message.id);
    else if (message.role === 'assistant') {
      const owner = message.turnId ? byNative.get(message.turnId) : current;
      owner?.messages.push(message);
    }
  }
  for (const activity of snapshot.activities) {
    // Native journal replay supplies ownership even for old stored activities.
    if (activity.turnId) byNative.get(activity.turnId)?.activities.push(activity);
  }
  return groups;
}

export function answers(messages: AgentMessage[], status: string): AgentMessage[] {
  const declared = messages.filter(message => message.phase === 'final_answer' || message.phase === 'partial_answer');
  if (declared.length) return declared;
  // Compatibility for models/history without phase metadata. Intermediate text
  // remains in working events while running; only the last unknown item is the
  // answer once the turn completes. Explicit commentary is never promoted.
  if (status === 'completed') {
    const unknown = messages.filter(message => !message.phase);
    return unknown.length ? unknown.slice(-1) : [];
  }
  return [];
}

const toolTitles: Record<string, string> = {
  commandExecution: 'Tool activity', webSearch: 'Web access', fileChange: 'Edit',
  mcpToolCall: 'Tool activity', dynamicToolCall: 'Tool activity', codeMode: 'Tool activity',
  Read: 'Read', Glob: 'List files', Grep: 'Search files', Write: 'Write', Edit: 'Edit',
  WebSearch: 'Web access', WebFetch: 'Web access', FetchURL: 'Web access', webReader: 'Web access',
  Skill: 'Skill', mcp__alma_files__copy_file: 'Tool activity', mcp__alma_files__delete_file: 'Tool activity',
  queued: 'Waiting for Provider', retrying: 'Retrying', compacting: 'Compacting context', provider_notice: 'Provider notice',
  plan: 'Plan', contextCompaction: 'Compacting context',
  reasoning_summary: 'Reasoning summary',
};
export function publicEvents(messages: AgentMessage[], activities: AgentActivity[], status: string): WorkingEvent[] {
  const finalIds = new Set(answers(messages, status).map(message => message.id));
  const rows = [
    ...messages.filter(message => message.text && !finalIds.has(message.id)).map(message => ({ sequence: message.sequence ?? 0,
      event: { id: `message:${message.id}`, title: 'Alma', detail: message.text, role: 'actor', kind: 'message',
        status: message.status === 'complete' ? 'completed' : liveTurn(status) ? 'running' : 'stopped', titleCode: null, detailTruncated: false, round: null } as WorkingEvent })),
    ...activities.map(activity => ({ sequence: activity.sequence ?? 0, event: {
      id: `tool:${activity.id}`, title: toolTitles[activity.kind] ?? activity.kind, detail: activity.text,
      role: 'actor', kind: 'activity', status: !liveTurn(status) && activity.status === 'running' ? 'stopped' : activity.status, titleCode: null,
      detailTruncated: Boolean(activity.detailTruncated), round: null,
    } as WorkingEvent })),
  ];
  return rows.sort((a, b) => a.sequence - b.sequence).map(row => row.event);
}

export function workingSummary(group: AgentTurnView): WorkingSummary {
  const live = liveTurn(group.turn.status);
  return { id: group.turn.id, position: group.position, revisionIndex: 0, phase: group.turn.status,
    startedAt: iso(group.turn.startedAtMs), endedAt: iso(group.turn.endedAtMs),
    events: publicEvents(group.messages, group.activities, group.turn.status).slice(-24).map(workingPreview),
    canOpen: Boolean(group.turn.turnId), live, progressing: live, criticPassed: false };
}
