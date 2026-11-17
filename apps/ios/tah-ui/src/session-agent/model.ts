export interface AgentMessage { id: string; role: string; text: string; status: string; turnId?: string | null; skill?: string | null; phase?: string | null; sequence?: number }
export interface AgentActivity { id: string; kind: string; text: string; status: string; turnId?: string | null; sequence?: number; detailTruncated?: boolean; callDetail?: string }
export interface AgentTurn { id: string; turnId: string | null; status: string; startedAtMs: number | null; endedAtMs: number | null }
export interface AgentModel { id: string; model: string; displayName?: string; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[] }
export interface AgentSnapshot {
  provider?: 'codex' | 'kimi' | 'zcode';
  version: number; sessionId: string; threadId: string | null; sourceTitle: string;
  skillBundle: string; language: string; model: string | null; effort: string | null;
  models: AgentModel[]; ready: boolean; busy: boolean; status: string; error: string | null;
  sequence: number; messages: AgentMessage[]; activities: AgentActivity[];
  turns?: AgentTurn[];
  skills: { id: string; description: string }[];
}
export interface AgentEvent { kind: string; id?: string; text?: string; delta?: string; skill?: string | null; turnId?: string | null; phase?: string | null; sequence?: number; complete?: boolean; status?: string; activity?: AgentActivity }
export interface AgentFrame { sequence: number; reset: boolean; snapshot: AgentSnapshot | null; state: Pick<AgentSnapshot, 'busy' | 'ready' | 'error' | 'status' | 'threadId' | 'turns'>; events: AgentEvent[] }
export type AgentCall = <T>(method: string, value?: Record<string, unknown>) => Promise<T>;
export interface AssetFile { path: string; bytes: number }

export function applyAgentFrame(previous: AgentSnapshot, frame: AgentFrame): AgentSnapshot {
  if (frame.reset && frame.snapshot) return frame.snapshot;
  if (frame.sequence < previous.sequence) return previous;
  const messages = [...previous.messages]; const activities = [...previous.activities];
  for (const event of frame.events) {
    if (event.kind === 'user' && event.id && !messages.some(message => message.id === event.id)) {
      messages.push({ id: event.id, role: 'user', text: event.text ?? '', skill: event.skill, status: 'pending', sequence: event.sequence });
    } else if (event.kind === 'started') {
      let index = messages.length - 1;
      while (index >= 0 && !(messages[index]!.role === 'user' && messages[index]!.status === 'pending')) index--;
      if (index >= 0) messages[index] = { ...messages[index]!, status: 'sent', turnId: event.turnId };
    } else if (event.kind === 'assistant' && event.id) {
      let index = messages.findIndex(message => message.id === event.id);
      if (index < 0) { index = messages.length; messages.push({ id: event.id, role: 'assistant', text: '', status: 'streaming', sequence: event.sequence }); }
      const old = messages[index]!;
      messages[index] = { ...old, turnId: event.turnId ?? old.turnId, phase: event.phase ?? old.phase, text: (event.text ?? old.text) + (event.delta ?? ''), status: event.complete ? 'complete' : old.status };
    } else if (event.kind === 'activity' && event.activity) {
      const index = activities.findIndex(activity => activity.id === event.activity!.id);
      const old = index < 0 ? undefined : activities[index];
      // Older frames put ownership on the envelope. New native frames carry
      // the canonical activity used by both the store and full working log.
      const activity = { ...event.activity, turnId: event.activity.turnId ?? event.turnId ?? old?.turnId,
        kind: event.activity.kind === 'tool' && old ? old.kind : event.activity.kind,
        sequence: old?.sequence ?? event.sequence };
      if (index < 0) activities.push(activity); else activities[index] = activity;
    } else if (event.kind === 'reconciled') {
      const index = messages.findIndex(message => message.id === event.id);
      if (index >= 0) messages[index] = { ...messages[index]!, turnId: event.turnId, status: event.status === 'completed' ? 'sent' : 'interrupted' };
    } else if (event.kind === 'finished') {
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (['pending', 'streaming'].includes(message.status)) messages[index] = { ...message, status: event.status === 'completed' ? 'complete' : 'interrupted' };
      }
    }
  }
  return { ...previous, ...frame.state, sequence: frame.sequence, messages, activities: activities.slice(-100) };
}

export function parseSkillCommand(text: string, selected: string | null): { text: string; skill: string | null } {
  const match = text.match(/^\/(asr-review|structured-notes)(?:\s+([\s\S]*))?$/u);
  return match ? { skill: match[1]!, text: match[2]?.trim() ?? '' } : { skill: selected, text: text.trim() };
}

export function businessLink(href: string, sourcePath?: string): string | null {
  let path = href;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (sourcePath && !path.startsWith('/workspace/') && !path.startsWith('assets/') && path !== 'transcript.md' && !/^[a-z][a-z\d+.-]*:/iu.test(path)) {
    try {
      const resolved = new URL(path, `https://alma.invalid/${sourcePath}`);
      if (resolved.origin !== 'https://alma.invalid') return null;
      path = resolved.pathname.slice(1);
    } catch { return null; }
  }
  if (path.startsWith('/workspace/')) {
    const asset = path.lastIndexOf('/assets/');
    if (asset >= 0) path = path.slice(asset + 1);
    else if (path.endsWith('/transcript.md')) path = 'transcript.md';
  }
  path = path.split('#', 1)[0]!;
  if (path !== 'transcript.md' && !path.startsWith('assets/')) return null;
  if (path.split('/').some(part => part === '..' || part === '.' || !part) || path.includes('\\')) return null;
  return path;
}

/** Keep known ASR machine metadata in the asset, outside its reading view. */
export function readableAssetMarkdown(text: string, sourcePath?: string): string {
  if (sourcePath !== 'assets/asr-review.md') return text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return text;
  const fields = new Map(match[1]!.split(/\r?\n/u).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
  if (fields.get('source') !== 'transcript.md' || fields.get('corrected_transcript') !== 'transcript.corrected.md') return text;
  const status = fields.get('review_status');
  if (status !== 'complete' && status !== 'incomplete') return text;
  const body = text.slice(match[0].length).trimStart();
  return status === 'incomplete' ? `> 审查尚未完成，内容仍可能更新。\n\n${body}` : body;
}
