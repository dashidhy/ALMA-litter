import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentConversation } from '../session-agent/AgentConversation';
import { answers, groupTurns, publicEvents } from '../session-agent/turns';
import { applyAgentFrame } from '../session-agent/model';
import { workingPreview } from '../session-agent/presentation';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import type { AgentCall, AgentSnapshot } from '../session-agent/model';

function fixture(): AgentSnapshot {
  return { version: 1, sessionId: 's', threadId: 'native', sourceTitle: 'Lecture', skillBundle: 'builtin-v1', language: '简体中文', model: 'model', effort: 'low', models: [], ready: true, busy: true, status: 'running', error: null, sequence: 9, skills: [],
    turns: [{ id: 'u1', turnId: 't1', status: 'completed', startedAtMs: 1000, endedAtMs: 5000 }, { id: 'u2', turnId: 't2', status: 'running', startedAtMs: 6000, endedAtMs: null }],
    messages: [
      { id: 'u1', turnId: 't1', role: 'user', text: '第一轮任务', status: 'sent', sequence: 1 },
      { id: 'a1', turnId: 't1', role: 'assistant', text: '先检查第一轮资料', phase: 'commentary', status: 'complete', sequence: 2 },
      { id: 'a2', turnId: 't1', role: 'assistant', text: '继续核实第一轮术语', phase: 'commentary', status: 'complete', sequence: 4 },
      { id: 'a3', turnId: 't1', role: 'assistant', text: '第一轮最终回答', phase: 'final_answer', status: 'complete', sequence: 5 },
      { id: 'u2', turnId: 't2', role: 'user', text: '第二轮任务', status: 'sent', sequence: 6 },
      { id: 'a4', turnId: 't2', role: 'assistant', text: '第二轮过程说明', phase: 'commentary', status: 'complete', sequence: 7 },
    ], activities: [{ id: 'tool1', turnId: 't1', kind: 'commandExecution', text: 'read first', status: 'completed', sequence: 3 }, { id: 'tool2', turnId: 't2', kind: 'webSearch', text: 'second term', status: 'running', sequence: 8 }] };
}
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(['codex', 'kimi', 'zcode'] as const)('renders %s tool frames in the live bubble and the full log', async provider => {
  const initial = fixture();
  const detail = '读取原始转写 👨‍👩‍👧‍👦 e\u0301 '.repeat(200);
  const tool = { id: 'native-read', kind: 'Read', text: detail, status: 'running' };
  const state = { busy: true, ready: true, error: null, status: 'running', threadId: 'native', turns: initial.turns };
  // Actual adapter shapes: Kimi used an envelope turnId, Codex/ZCode nested it.
  const event = provider === 'kimi' ? { kind: 'activity', turnId: 't2', activity: tool, sequence: 10 }
    : { kind: 'activity', activity: { ...tool, turnId: 't2' }, sequence: 10 };
  const live = applyAgentFrame(initial, { sequence: 10, reset: false, snapshot: null, state, events: [event] });
  const finishedTool = { ...tool, kind: provider === 'kimi' ? 'tool' : 'Read', status: 'completed' };
  const next = applyAgentFrame(live, { sequence: 11, reset: false, snapshot: null, state, events: [
    { kind: 'activity', turnId: 't2', activity: finishedTool, sequence: 11 },
  ] });
  const call: AgentCall = async <T,>() => ({ turn: next.turns![1],
    messages: next.messages.filter(m => m.role === 'assistant' && m.turnId === 't2'),
    activities: next.activities.filter(a => a.turnId === 't2'), limited: false } as T);
  await act(async () => root.render(<AgentConversation snapshot={next} call={call} style="bubbles" openFile={() => {}} openExternal={() => {}} />));
  const row = host.querySelector('[data-event-id="tool:native-read"]')!;
  expect(row).not.toBeNull(); expect(row.textContent).toContain('Read');
  expect(row.textContent).toContain('completed');
  expect(row.querySelector('.event-detail')?.textContent).toBe(workingPreview(publicEvents([], [next.activities.find(a => a.id === tool.id)!], 'running')[0]!).detail);
  expect(next.activities.find(a => a.id === tool.id)?.text).toBe(detail);
  await act(async () => (host.querySelectorAll('.working-log-link')[1] as HTMLButtonElement).click());
  expect(host.querySelector('.working-log-panel [data-event-id="tool:native-read"] .event-detail')?.textContent).toBe(detail);
});

it('matches the original TAH byte-limited head/tail preview exactly', () => {
  const original = readFileSync('../../../shared/tah-runtime/upstream/src/app-runtime/presentation.ts', 'utf8');
  const body = original.slice(original.indexOf('function clipText(')).replace('function clipText(value: string, maximumBytes: number): string', 'function clipText(value, maximumBytes)');
  const reference = new Function('Buffer', body.replaceAll('bytes[head]!', 'bytes[head]').replaceAll('bytes[tail]!', 'bytes[tail]') + '; return clipText;')(Buffer);
  for (const character of ['a', '中', 'e\u0301', '👨‍👩‍👧‍👦', '🇨🇳']) {
    for (const length of [0, 3, 80, 85, 128, 255, 256, 257, 1000]) {
      const detail = character.repeat(length);
      const event = publicEvents([], [{id:'t', kind:'Read', text:detail, status:'running'}], 'running')[0]!;
      const preview = workingPreview(event);
      expect(preview.detail).toBe(reference(detail, 256));
      expect(Buffer.byteLength(preview.detail)).toBeLessThanOrEqual(256);
      expect(event.detail).toBe(detail);
    }
  }
});

it('shortens process messages but leaves final answers and source data intact', async () => {
  const s = fixture();
  const long = '中文过程说明。'.repeat(100);
  s.messages.find(m => m.id === 'a4')!.text = long;
  s.messages.find(m => m.id === 'a3')!.text = long;
  const call: AgentCall = async <T,>() => ({} as T);
  await act(async () => root.render(<AgentConversation snapshot={s} call={call} style="bubbles" openFile={() => {}} openExternal={() => {}} />));
  expect(host.querySelector('[data-event-id="message:a4"] .event-detail')?.textContent).toBe(workingPreview(publicEvents([s.messages.find(m=>m.id==='a4')!], [], 'running')[0]!).detail);
  expect(host.querySelectorAll('.agent-turn')[0]!.textContent).toContain(long);
  expect(s.messages.find(m => m.id === 'a4')!.text).toBe(long);
});

it('groups late recovered messages by native turn, preserving process chronology', () => {
  const s = fixture(); const recovered = s.messages.splice(2, 1)[0]!; s.messages.push(recovered);
  const groups = groupTurns(s);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.messages.map(m => m.id)).toContain('a2');
  expect(groups[1]!.messages.map(m => m.id)).not.toContain('a2');
  expect(publicEvents(groups[0]!.messages, groups[0]!.activities, 'completed').map(e => e.id)).toEqual(['message:a1', 'tool:tool1', 'message:a2']);
});

it('keeps unknown phase text in working events until completion, without promoting known commentary', () => {
  const messages = fixture().messages.filter(m => m.role === 'assistant').slice(0, 2).map(m => ({ ...m, phase: null }));
  expect(answers(messages, 'running')).toEqual([]);
  expect(answers(messages, 'completed').map(m => m.id)).toEqual(['a2']);
  expect(answers([{ ...messages[0]!, phase: 'commentary' }], 'completed')).toEqual([]);
});

it('keeps turn ownership and phase through streamed deltas and final authoritative text', () => {
  const s = fixture();
  const state = { busy: true, ready: true, error: null, status: 'running', threadId: 'native', turns: s.turns };
  const next = applyAgentFrame(s, { sequence: 12, reset: false, snapshot: null, state, events: [
    { kind: 'assistant', id: 'a5', turnId: 't2', phase: 'final_answer', text: '', sequence: 10 },
    { kind: 'assistant', id: 'a5', turnId: 't2', delta: '答', sequence: 11 },
    { kind: 'assistant', id: 'a5', turnId: 't2', phase: 'final_answer', text: '答案', complete: true, sequence: 12 },
  ] });
  expect(next.messages.filter(m => m.id === 'a5')).toEqual([expect.objectContaining({ text: '答案', turnId: 't2', phase: 'final_answer', sequence: 10 })]);
});

it('uses one assistant block per request and the original live/completed Working behavior', async () => {
  const s = fixture(); const call: AgentCall = async <T,>() => ({} as T);
  const render = () => root.render(<AgentConversation snapshot={s} call={call} style="bubbles" openFile={() => {}} openExternal={() => {}} />);
  await act(async () => render());
  expect(host.querySelectorAll('.message-assistant')).toHaveLength(2);
  const groups = host.querySelectorAll('.agent-turn');
  expect(groups[0]!.textContent).toContain('第一轮最终回答');
  expect(groups[0]!.textContent).not.toContain('先检查第一轮资料');
  expect(groups[0]!.querySelector('.working-disclosure')).toBeNull();
  expect(groups[0]!.querySelector('.working-log-link')).not.toBeNull();
  expect(groups[1]!.querySelector('.working-disclosure[open]')).not.toBeNull();
  expect(groups[1]!.textContent).toContain('第二轮过程说明');
  expect(groups[1]!.textContent).not.toContain('read first');
  s.turns![1] = { ...s.turns![1]!, status: 'completed', endedAtMs: 15000 };
  s.messages = [...s.messages, { id: 'final2', turnId: 't2', role: 'assistant', phase: 'final_answer', text: '第二轮完成', status: 'complete' }];
  s.busy = false; s.status = 'completed'; s.sequence++;
  await act(async () => root.render(<AgentConversation snapshot={{ ...s }} call={call} style="bubbles" openFile={() => {}} openExternal={() => {}} />));
  expect(host.querySelectorAll('.message-assistant')).toHaveLength(2);
  expect(host.querySelectorAll('.working-disclosure')).toHaveLength(0);
  expect(host.querySelectorAll('.working-log-link')).toHaveLength(2);
});

it('loads only the selected turn into the existing full WorkingLogPanel and closes back to chat', async () => {
  const s = fixture(); const requested: Record<string, unknown>[] = [];
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    expect(method).toBe('agent.workingLog'); requested.push(value);
    return { turn: s.turns![0], messages: s.messages.filter(m => m.role === 'assistant' && m.turnId === 't1'), activities: s.activities.filter(a => a.turnId === 't1'), limited: false } as T;
  };
  await act(async () => root.render(<AgentConversation snapshot={s} call={call} style="bubbles" openFile={() => {}} openExternal={() => {}} />));
  await act(async () => (host.querySelector('.working-log-link') as HTMLButtonElement).click());
  expect(requested).toEqual([{ id: 'u1' }]);
  const log = host.querySelector('.working-log-panel')!;
  expect(log.textContent).toContain('第 1 轮');
  expect(log.textContent).toContain('先检查第一轮资料');
  expect(log.textContent).toContain('read first');
  expect(log.textContent).not.toContain('second term');
  expect(log.querySelectorAll('.working-event')).toHaveLength(3);
  await act(async () => (host.querySelector('[aria-label="Close Working events"]') as HTMLButtonElement).click());
  expect(host.querySelector('dialog')).toBeNull();
  expect(host.querySelectorAll('.message-assistant')).toHaveLength(2);
});
