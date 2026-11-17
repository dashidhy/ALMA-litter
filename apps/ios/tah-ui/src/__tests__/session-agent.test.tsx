import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyAgentFrame, businessLink, parseSkillCommand, readableAssetMarkdown } from '../session-agent/model';
import type { AgentCall, AgentSnapshot } from '../session-agent/model';
import SessionAgent from '../session-agent/SessionAgent';
import { AgentContent } from '../session-agent/AgentContent';

const snapshot = (): AgentSnapshot => ({ version: 1, sessionId: 's1', threadId: 'native1', sourceTitle: 'NVIDIA', skillBundle: 'builtin-v1',
  language: '简体中文', model: 'model', effort: 'medium', models: [], ready: true, busy: false, status: 'completed', error: null,
  sequence: 0, messages: [], activities: [], skills: [{ id: 'asr-review', description: 'review' }, { id: 'structured-notes', description: 'notes' }] });

it('renders the report body while preserving machine metadata in the stored asset', () => {
  const source = '---\nsource: transcript.md\ncorrected_transcript: transcript.corrected.md\nreview_status: complete\n---\n\n# ASR 疑点与纠正';
  expect(readableAssetMarkdown(source, 'assets/asr-review.md')).toBe('# ASR 疑点与纠正');
  expect(readableAssetMarkdown(source, 'assets/other.md')).toBe(source);
  expect(source).toContain('review_status: complete');
});

it('keeps incomplete review status visible without showing raw metadata fields', () => {
  const source = '---\nsource: transcript.md\ncorrected_transcript: transcript.corrected.md\nreview_status: incomplete\n---\n\n# ASR 疑点与纠正';
  const body = readableAssetMarkdown(source, 'assets/asr-review.md');
  expect(body).toContain('审查尚未完成');
  expect(body).not.toContain('review_status:');
  expect(body).toContain('# ASR 疑点与纠正');
});

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('accumulates streamed text once and replaces it with the authoritative completion', () => {
  const initial = snapshot();
  const running = applyAgentFrame(initial, { sequence: 3, reset: false, snapshot: null,
    state: { ready: true, busy: true, status: 'running', error: null, threadId: 'native1' },
    events: [{ kind: 'user', id: 'u', text: 'question' }, { kind: 'started', turnId: 't' }, { kind: 'assistant', id: 'a', delta: 'part' }] });
  const complete = applyAgentFrame(running, { sequence: 5, reset: false, snapshot: null,
    state: { ready: true, busy: false, status: 'completed', error: null, threadId: 'native1' },
    events: [{ kind: 'assistant', id: 'a', text: 'complete answer', complete: true }, { kind: 'finished', status: 'completed' }] });
  expect(complete.messages).toHaveLength(2);
  expect(complete.messages[1]?.text).toBe('complete answer');
  expect(complete.threadId).toBe('native1');
  expect(complete.messages[0]?.turnId).toBe('t');
});

it('uses native skill selection without turning ordinary QA into a mandatory review', () => {
  expect(parseSkillCommand('/structured-notes 保留技术细节', null)).toEqual({ skill: 'structured-notes', text: '保留技术细节' });
  expect(parseSkillCommand('这段讲什么？', null)).toEqual({ skill: null, text: '这段讲什么？' });
  expect(parseSkillCommand('', 'asr-review')).toEqual({ skill: 'asr-review', text: '' });
});

it('only routes business file links to the workspace reader', () => {
  expect(businessLink('/workspace/sessions/id/workspace/assets/notes.md')).toBe('assets/notes.md');
  expect(businessLink('assets/notes.md#heading')).toBe('assets/notes.md');
  expect(businessLink('https://example.com/workspace/a/assets/private')).toBeNull();
  expect(businessLink('assets/%2e%2e/provider-state/auth.json')).toBeNull();
  expect(businessLink('file:///private/auth.json')).toBeNull();
  expect(businessLink('asr-review.md#ASR-02', 'assets/structured-notes.md')).toBe('assets/asr-review.md');
  expect(businessLink('../../provider-state/auth.json', 'assets/structured-notes.md')).toBeNull();
  expect(businessLink('//example.com/private', 'assets/structured-notes.md')).toBeNull();
});

it('opens relative links within generated notes in the workspace reader', async () => {
  const file = vi.fn(), external = vi.fn();
  await act(async () => root.render(<AgentContent markdown sourcePath="assets/structured-notes.md" text="[疑点](asr-review.md#ASR-02)" openFile={file} openExternal={external} />));
  await act(async () => (host.querySelector('a') as HTMLAnchorElement).click());
  expect(file).toHaveBeenCalledWith('assets/asr-review.md'); expect(external).not.toHaveBeenCalled();
});

it('opens an actual asset link without navigating to an external URL or accepting active HTML', async () => {
  const file = vi.fn(), external = vi.fn();
  await act(async () => root.render(<AgentContent markdown text={'[笔记](assets/notes.md)\n\n<img src="https://bad.example/pixel" onerror="alert(1)">'} openFile={file} openExternal={external} />));
  expect(host.querySelector('img,script')).toBeNull();
  await act(async () => (host.querySelector('a') as HTMLAnchorElement).click());
  expect(file).toHaveBeenCalledWith('assets/notes.md'); expect(external).not.toHaveBeenCalled();
});

it('starts with no model request and sends an explicit selected skill only on Send', async () => {
  const calls: { method: string; value: Record<string, unknown> }[] = [];
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    calls.push({ method, value });
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [] } as T;
    return snapshot() as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  expect(calls.some(c => c.method === 'agent.send')).toBe(false);
  await act(async () => (host.querySelector('[aria-label="选择 Skill"]') as HTMLButtonElement).click());
  const choice = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('结构化笔记'))!;
  await act(async () => choice.click());
  await act(async () => (host.querySelector('[aria-label="发送"]') as HTMLButtonElement).click());
  expect(calls.find(c => c.method === 'agent.send')?.value).toEqual({ text: '', skill: 'structured-notes' });
  expect(calls.some(c => /guardian|createStructuredNotesAction|checkRawSafety/.test(c.method))).toBe(false);
});

it('hides the keyboard without sending or losing the draft, and keeps it across settings', async () => {
  window.localStorage.setItem('alma.session-agent.draft.v1/s1', JSON.stringify({ text: '请保留这个草稿', skill: null }));
  const calls: string[] = [];
  const call: AgentCall = async <T,>(method: string) => {
    calls.push(method);
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [] } as T;
    return snapshot() as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  const input = host.querySelector('textarea')!;
  input.focus();
  const hide = host.querySelector<HTMLButtonElement>('[aria-label="收起键盘"]')!;
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
  await act(async () => { hide.dispatchEvent(pointer); hide.click(); });
  expect(pointer.defaultPrevented).toBe(true);
  expect(document.activeElement).not.toBe(input);
  expect(input.value).toBe('请保留这个草稿');
  await act(async () => (host.querySelector('.configuration-button') as HTMLButtonElement).click());
  await act(async () => (host.querySelector('[aria-label="返回"]') as HTMLButtonElement).click());
  expect(host.querySelector('textarea')?.value).toBe('请保留这个草稿');
  expect(calls).not.toContain('agent.send');
});

it('admits one pending send and preserves text entered while its acknowledgement is pending', async () => {
  window.localStorage.setItem('alma.session-agent.draft.v1/s1', JSON.stringify({ text: '第一条问题', skill: null }));
  const sent: Record<string, unknown>[] = [];
  let acknowledge: (value: AgentSnapshot) => void = () => {};
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [] } as T;
    if (method === 'agent.send') { sent.push(value); return new Promise<AgentSnapshot>(resolve => { acknowledge = resolve; }) as Promise<T>; }
    return snapshot() as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  const form = host.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const input = host.querySelector('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '新的草稿'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => acknowledge(snapshot()));
  expect(sent).toEqual([{ text: '第一条问题', skill: null }]);
  expect(input.value).toBe('新的草稿');
});

it('returns from a scrolled long document to an independent visible asset list', async () => {
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [
      { path: 'assets/structured-notes.md', bytes: 33000 },
      { path: 'assets/asr-review.md', bytes: 40000 },
    ] } as T;
    if (method === 'agent.read') return { path: value.path, text: '# 长笔记\n\n' + '讲座内容。\n\n'.repeat(500) } as T;
    return snapshot() as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('成果'))!.click());
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('structured-notes.md'))!.click());
  const reader = host.querySelector('main')!;
  reader.scrollTop = 12000;
  reader.scrollLeft = 500;
  await act(async () => (host.querySelector('[aria-label="返回"]') as HTMLButtonElement).click());
  const list = host.querySelector('main')!;
  expect(host.querySelector('h1')?.textContent).toBe('共享成果');
  expect(list.textContent).toContain('structured-notes.md');
  expect(list.textContent).toContain('asr-review.md');
  expect(list.scrollTop).toBe(0);
  expect(list.scrollLeft).toBe(0);
  expect(list).not.toBe(reader);
});

it('routes model and reasoning selectors through configure and displays the backend receipt', async () => {
  let state: AgentSnapshot = { ...snapshot(), model: 'engine-a', effort: 'low', models: [
    { id: 'catalog-a', model: 'engine-a', displayName: 'Model A', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'catalog-b', model: 'engine-b', displayName: 'Model B', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  ] };
  const configurations: Record<string, unknown>[] = [];
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [] } as T;
    if (method === 'agent.configure') {
      configurations.push(value);
      state = { ...state, model: typeof value.model === 'string' ? value.model : state.model,
        effort: typeof value.effort === 'string' ? value.effort : state.effort, sequence: state.sequence + 1 };
    }
    return state as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  await act(async () => (host.querySelector('.configuration-button') as HTMLButtonElement).click());
  const models = host.querySelector<HTMLSelectElement>('[aria-label="模型"]')!;
  expect(models.options.length).toBe(2);
  await act(async () => { models.value = 'engine-b'; models.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(configurations[0]).toEqual({ sessionId: 's1', model: 'engine-b', effort: 'medium' });
  const effort = host.querySelector<HTMLSelectElement>('[aria-label="推理强度"]')!;
  expect([...effort.options].map(option => option.value)).toEqual(['medium', 'high']);
  await act(async () => { effort.value = 'high'; effort.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(configurations[1]).toEqual({ sessionId: 's1', effort: 'high' });
  await act(async () => (host.querySelector('[aria-label="返回"]') as HTMLButtonElement).click());
  expect(host.querySelector('.configuration-button')?.textContent).toBe('Model B · high');
  await act(async () => (host.querySelector('.configuration-button') as HTMLButtonElement).click());
  expect(host.querySelector<HTMLSelectElement>('[aria-label="模型"]')?.value).toBe('engine-b');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="推理强度"]')?.value).toBe('high');
});

it('saves inference selection without reconnecting or replacing newer conversation events', async () => {
  const state: AgentSnapshot = { ...snapshot(), model:'a', effort:'low', models:[
    {id:'a',model:'a',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},
    {id:'b',model:'b',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},
  ], messages:[{id:'u',role:'user',text:'Question',status:'sent',turnId:'t'}],
  turns:[{id:'u',turnId:'t',status:'completed',startedAtMs:1,endedAtMs:2}] };
  const calls:string[]=[];let save:((value:AgentSnapshot)=>void)|undefined;
  let update:((value:unknown)=>void)|undefined;
  const call:AgentCall=async<T,>(method:string)=>{
    calls.push(method);
    if(method==='agent.sessions')return{sessions:[]}as T;
    if(method==='agent.assets')return{files:[]}as T;
    if(method==='agent.events')return new Promise<T>(resolve=>{update=resolve as (value:unknown)=>void;});
    if(method==='agent.configure')return new Promise<T>(resolve=>{save=resolve as (value:AgentSnapshot)=>void;});
    return state as T;
  };
  await act(async()=>root.render(<SessionAgent onBack={()=>{}} call={call}/>));
  await act(async()=>(host.querySelector('.configuration-button') as HTMLButtonElement).click());
  await act(async()=>{const select=host.querySelector<HTMLSelectElement>('[aria-label="模型"]')!;select.value='b';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(host.textContent).not.toContain('正在连接已有会话');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="模型"]')?.value).toBe('b');
  await act(async()=>update?.({sequence:1,reset:false,snapshot:null,state:{busy:false,ready:true,error:null,status:'completed',threadId:'native1',turns:state.turns},events:[{kind:'assistant',id:'fresh',turnId:'t',phase:'final_answer',text:'New response',complete:true,sequence:1}]}));
  await act(async()=>save?.({...state,model:'b',effort:'high'}));
  await act(async()=>(host.querySelector('[aria-label="返回"]') as HTMLButtonElement).click());
  expect(host.textContent).toContain('New response');
  expect(calls.filter(m=>m==='agent.open')).toHaveLength(1);
  expect(calls.filter(m=>m==='agent.assets')).toHaveLength(1);
  expect(calls).not.toContain('agent.close');
  expect(calls).not.toContain('agent.send');
});

it('routes Stop and source reading through the real UI command names', async () => {
  const calls: { method: string; value: Record<string, unknown> }[] = [];
  const state = { ...snapshot(), busy: true, status: 'running' };
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    calls.push({ method, value });
    if (method === 'agent.sessions') return { sessions: [] } as T;
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return { files: [] } as T;
    if (method === 'agent.read') return { path: value.path, text: '# 原始转写' } as T;
    return state as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  await act(async () => (host.querySelector('[aria-label="停止"]') as HTMLButtonElement).click());
  expect(calls.filter(item => item.method === 'agent.cancel')).toHaveLength(1);
  await act(async () => (host.querySelector('.agent-source-heading .source-row') as HTMLButtonElement).click());
  expect(calls.find(item => item.method === 'agent.read')?.value).toEqual({ path: 'transcript.md' });
  expect(host.querySelector('main')?.textContent).toContain('原始转写');
});

it('creates a separate provider workspace and never sends a model request on opening', async () => {
  const calls: {method: string; value: Record<string, unknown>}[] = [];
  let current = {...snapshot(), provider: 'codex' as const} as AgentSnapshot;
  const call: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
    calls.push({method,value});
    if (method === 'agent.events') return new Promise<T>(() => {});
    if (method === 'agent.assets') return {files: []} as T;
    if (method === 'agent.sessions') return {sessions: [{sessionId:'s1',provider:'codex',hasMessages:true}]} as T;
    if (method === 'agent.newSession') current = {...snapshot(),sessionId:'kimi-new',threadId:null,provider:'kimi',model:'kimi-for-coding'};
    return current as T;
  };
  await act(async () => root.render(<SessionAgent onBack={() => {}} call={call} />));
  await act(async () => (host.querySelector('[aria-label="会话设置"]') as HTMLButtonElement).click());
  expect(host.textContent).toContain('codex · s1 · 已有对话');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '新建 Kimi')!.click());
  expect(calls.find(item => item.method === 'agent.newSession')?.value).toEqual({provider:'kimi'});
  expect(calls.some(item => item.method === 'agent.send')).toBe(false);
  expect(calls.filter(item => item.method === 'agent.open')).toHaveLength(2);
});
