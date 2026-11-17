import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentContent } from './AgentContent';
import { AgentConversation } from './AgentConversation';
import { applyAgentFrame, parseSkillCommand } from './model';
import type { AgentCall, AgentFrame, AgentSnapshot, AssetFile } from './model';
import { useComposerInset, useViewport } from '../useViewport';
import { Icon } from '../components/Icon';
import { loadChatStyle, saveChatStyle } from '../chatStyle';
import { loadReadingTheme, saveReadingTheme } from '../readingTheme';
import { setNativeTheme } from '../bridge';

export const nativeAgentCall: AgentCall = async <T,>(method: string, value: Record<string, unknown> = {}) => {
  const result = await invoke<T & { error?: string; sessionId?: string }>('tah_ui', { method, value });
  if (result?.error && !result.sessionId) throw new Error(result.error);
  return result;
};

const errorText = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    authorization_required: '请先连接当前 Provider 的账号。', authorization_changed: '当前账号与这条对话的授权不同，请切回原账号。',
    legacy_task_busy: '旧版任务仍在运行，请先完成或停止它。', session_busy_or_closed: '当前会话正在处理或尚未连接。',
    model_turn_failed: '这次请求未完成。已有对话和文件已保留。', provider_error: '模型服务返回错误，请查看当前任务状态。',
  };
  return known[code] ?? code;
};

export default function SessionAgent({ onBack, call = nativeAgentCall }: { onBack: () => void; call?: AgentCall }) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [opening, setOpening] = useState(false);
  const [sessions, setSessions] = useState<{sessionId: string; provider: string; hasMessages: boolean}[]>([]);
  const [theme, setTheme] = useState(loadReadingTheme);
  const [chatStyle, setChatStyle] = useState(loadChatStyle);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [skill, setSkill] = useState<string | null>(null);
  const [skillMenu, setSkillMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const configurationPending = useRef(false);
  const sendPending = useRef(false);
  const [draftSession, setDraftSession] = useState<string | null>(null);
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [panel, setPanel] = useState<'files' | 'settings' | null>(null);
  const [reading, setReading] = useState<{ path: string; text: string } | null>(null);
  const [readBusy, setReadBusy] = useState(false);
  const shell = useViewport(); const scroll = useRef<HTMLDivElement>(null);
  const { area, composer } = useComposerInset(!reading && !panel);
  const after = useRef(0); const generation = useRef(0); const alive = useRef(true);
  const stayAtBottom = useRef(true); const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    void setNativeTheme(theme === 'ink').catch(() => {});
  }, [theme]);

  const refreshFiles = useCallback(async () => {
    try { const result = await call<{ files: AssetFile[] }>('agent.assets'); if (alive.current) setFiles(result.files); }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
  }, [call]);

  const connect = useCallback(async (method = 'agent.open', values: Record<string, unknown> = {}) => {
    const current = ++generation.current; setOpening(true); setError(null);
    try {
      const next = await call<AgentSnapshot>(method, { language: '简体中文', ...values });
      if (!alive.current || generation.current !== current) return;
      after.current = next.sequence; setSnapshot(next); setError(next.error ? errorText(next.error) : null);
      await refreshFiles();
    } catch (failure) { if (alive.current && generation.current === current) setError(errorText(failure)); }
    finally { if (alive.current && generation.current === current) setOpening(false); }
  }, [call, refreshFiles]);

  async function configure(values: { model?: string; effort?: string }) {
    if (!snapshot || snapshot.busy || opening || configurationPending.current) return;
    const previous = { model: snapshot.model, effort: snapshot.effort };
    const id = snapshot.sessionId;
    configurationPending.current = true; setConfiguring(true); setError(null);
    setSnapshot(current => current?.sessionId === id ? { ...current, ...values } : current);
    try {
      const next = await call<AgentSnapshot>('agent.configure', { sessionId: id, ...values });
      if (alive.current) setSnapshot(current => current?.sessionId === id
        ? { ...current, model: next.model, effort: next.effort } : current);
    } catch (failure) {
      if (alive.current) {
        setSnapshot(current => current?.sessionId === id ? { ...current, ...previous } : current);
        setError(errorText(failure));
      }
    } finally { configurationPending.current = false; if (alive.current) setConfiguring(false); }
  }

  useEffect(() => {
    alive.current = true; void connect();
    return () => { alive.current = false; generation.current++; };
  }, [connect]);

  const sessionId = snapshot?.sessionId;
  useEffect(() => {
    if (panel !== 'settings') return;
    let active = true;
    void call<{sessions: typeof sessions}>('agent.sessions').then(value => { if (active) setSessions(value.sessions); }).catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [panel, sessionId, call]);
  async function newProviderSession(provider: string) {
    setOpening(true); setError(null);
    try {
      await call('agent.newSession', { provider });
      setPanel(null); await connect();
    } catch (failure) { setError(errorText(failure)); }
    finally { setOpening(false); }
  }
  const providerName = snapshot?.provider === 'kimi' ? 'Kimi' : snapshot?.provider === 'zcode' ? 'ZCode' : 'Codex';
  useEffect(() => {
    if (!sessionId) return;
    let text = ''; let selected: string | null = null;
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(`alma.session-agent.draft.v1/${sessionId}`) ?? 'null');
      if (saved && typeof saved === 'object' && 'text' in saved && typeof saved.text === 'string' && saved.text.length <= 65536) {
        text = saved.text;
        if ('skill' in saved && (saved.skill === 'asr-review' || saved.skill === 'structured-notes')) selected = saved.skill;
      }
    } catch { /* A malformed draft cannot prevent restoring the conversation. */ }
    setDraft(text); setSkill(selected); setSkillMenu(false);
    setDraftSession(sessionId);
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || draftSession !== sessionId) return;
    try { window.localStorage.setItem(`alma.session-agent.draft.v1/${sessionId}`, JSON.stringify({ text: draft, skill })); }
    catch { /* Native submitted messages remain durable independently. */ }
  }, [sessionId, draftSession, draft, skill]);
  useEffect(() => {
    if (!sessionId || opening) return;
    let stopped = false;
    async function consume() {
      while (!stopped) {
        if (document.hidden) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
        try {
          const frame = await call<AgentFrame>('agent.events', { after: after.current });
          if (stopped || !alive.current) return;
          after.current = frame.sequence;
          setSnapshot(previous => previous ? applyAgentFrame(previous, frame) : frame.snapshot);
          if (frame.events.some(event => event.kind === 'finished')) void refreshFiles();
        } catch (failure) {
          if (stopped || !alive.current) return;
          setError(errorText(failure)); await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
    }
    void consume(); return () => { stopped = true; };
  }, [call, sessionId, opening, refreshFiles]);

  useEffect(() => {
    if (stayAtBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot?.sequence, reading]);

  async function send() {
    if (!snapshot?.ready || snapshot.busy || opening || configurationPending.current || sendPending.current) return;
    const request = parseSkillCommand(draft, skill);
    if (!request.text && !request.skill) return;
    sendPending.current = true; setSending(true); setError(null); stayAtBottom.current = true;
    try {
      await call('agent.send', request);
      setDraft(current => current === draft ? '' : current);
      setSkill(current => current === skill ? null : current); setSkillMenu(false);
    } catch (failure) { setError(errorText(failure)); }
    finally { sendPending.current = false; setSending(false); }
  }
  const openFile = useCallback(async (path: string) => {
    setReadBusy(true); setError(null);
    try { const result = await call<{ path: string; text: string }>('agent.read', { path }); if (alive.current) setReading(result); }
    catch (failure) { if (alive.current) setError(errorText(failure)); }
    finally { if (alive.current) setReadBusy(false); }
  }, [call]);
  const openExternal = useCallback((url: string) => { void call('openExternal', { url }).catch(failure => setError(errorText(failure))); }, [call]);
  const chooseSkill = (id: string) => { setSkill(id); setSkillMenu(false); if (draft.startsWith('/')) setDraft(''); input.current?.focus(); };
  async function leave() {
    setOpening(true);
    try { await call('agent.leave'); onBack(); }
    catch (failure) { setError(errorText(failure)); setOpening(false); }
  }
  const shownError = error ?? (snapshot?.error ? errorText(snapshot.error) : null);
  const candidates = draft.startsWith('/') ? snapshot?.skills.filter(item => `/${item.id}`.startsWith(draft.trim())) ?? [] : [];
  const model = snapshot?.models?.find(item => item.id === snapshot.model || item.model === snapshot.model);
  const openSettings = () => { setReading(null); setSkillMenu(false); setPanel(panel === 'settings' ? null : 'settings'); };
  const skillName = (id: string) => id === 'asr-review' ? 'ASR 审查' : '结构化笔记';

  return <div className="app-shell agent-shell" ref={shell}>
    <header className="app-header">
      <button className="icon-button" onClick={() => { if (reading) setReading(null); else if (panel) setPanel(null); else void leave(); }} aria-label="返回" disabled={opening}><Icon name="back" /></button>
      <h1>{reading ? reading.path.split('/').at(-1) : panel === 'files' ? '共享成果' : panel === 'settings' ? '会话设置' : 'Session Agent'}</h1>
      <button className="icon-button" aria-label="会话设置" onClick={openSettings}><Icon name="settings" /></button>
    </header>
    {shownError ? <p className="error agent-notice" role="alert">{shownError}</p> : null}
    {opening ? <p className="agent-notice" role="status"><span className="spinner" /> 正在连接已有会话…</p> : null}
    {!snapshot?.ready && !opening ? <div className="button-row agent-notice">
      <button className="primary" onClick={() => void connect('agent.login')}>连接 {providerName}</button>
      <button className="secondary" onClick={() => void connect()}>重试／继续</button>
    </div> : null}
    {reading ? <main key={`reader:${reading.path}`} className="agent-reader"><AgentContent text={reading.text} markdown sourcePath={reading.path} openFile={path => void openFile(path)} openExternal={openExternal} /></main> :
      panel === 'settings' ? <main key="settings" className="agent-reader">
        <h2>{providerName}</h2><p>联网搜索默认开启。此入口使用独立的持久对话。</p>
        <label>阅读主题<select aria-label="阅读主题" value={theme} onChange={event => { const next = event.target.value === 'paper' ? 'paper' : 'ink'; saveReadingTheme(next); setTheme(next); }}><option value="ink">深色</option><option value="paper">纸色</option></select></label>
        <label>对话样式<select aria-label="对话样式" value={chatStyle} onChange={event => { const next = event.target.value === 'light' ? 'light' : 'bubbles'; saveChatStyle(next); setChatStyle(next); }}><option value="bubbles">双侧气泡</option><option value="light">轻量对话</option></select></label>
        <label>模型<select aria-label="模型" value={snapshot?.model ?? ''} disabled={opening || configuring || snapshot?.busy} onChange={event => {
          const selected = snapshot?.models.find(item => item.id === event.target.value || item.model === event.target.value);
          void configure({ model: event.target.value, effort: selected?.defaultReasoningEffort ?? selected?.supportedReasoningEfforts?.[0]?.reasoningEffort });
        }}>
          {(snapshot?.models ?? []).map(item => <option key={item.id} value={item.model || item.id}>{item.displayName ?? item.model ?? item.id}</option>)}
        </select></label>
        <label>推理强度<select aria-label="推理强度" value={snapshot?.effort ?? ''} disabled={opening || configuring || snapshot?.busy} onChange={event => void configure({ effort: event.target.value })}>
          {(model?.supportedReasoningEfforts ?? []).map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}
        </select></label>
        <h2>独立测试会话</h2><p>每条会话固定一个 Provider。新建会话保留已有对话与成果。</p>
        <div className="button-row">{['codex', 'kimi', 'zcode'].map(provider => <button className="secondary" key={provider} disabled={opening || snapshot?.busy} onClick={() => void newProviderSession(provider)}>新建 {provider === 'codex' ? 'Codex' : provider === 'kimi' ? 'Kimi' : 'ZCode'}</button>)}</div>
        {sessions.map(session => <button className="source-row" key={session.sessionId} disabled={opening || snapshot?.busy || session.sessionId === snapshot?.sessionId} onClick={() => { setPanel(null); void connect('agent.open', {sessionId: session.sessionId}); }}>{session.provider} · {session.sessionId.slice(0,8)} · {session.hasMessages ? '已有对话' : '空白'}</button>)}
        <details><summary>会话信息</summary><p className="agent-id">Session: {snapshot?.sessionId}<br />Thread: {snapshot?.threadId}<br />Skills: {snapshot?.skillBundle}</p></details>
      </main> : panel === 'files' ? <main key="files" className="agent-reader">
        <button className="source-row" onClick={() => void openFile('transcript.md')} disabled={readBusy}><strong>原始 transcript</strong><small>只读</small></button>
        <h2>Assets</h2>{files.length ? files.map(file => <button className="agent-file" key={file.path} onClick={() => void openFile(file.path)} disabled={readBusy}><span>{file.path.slice(7)}</span><small>{Math.ceil(file.bytes / 1024)} KB</small></button>) : <p>目前还没有成果。可以先自由提问，或调用 Skill 生成笔记。</p>}
      </main> : <div className="work-area" ref={area}>
        <main key="chat" className="agent-chat workspace-scroll has-composer" ref={scroll} onScroll={() => { const area = scroll.current; if (area) stayAtBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 100; }}>
          <div className="agent-source-heading"><button className="source-row" onClick={() => void openFile('transcript.md')}><Icon name="document" /><span><small>TRANSCRIPT</small><strong>{snapshot?.sourceTitle ?? 'NVIDIA transcript'}</strong></span><Icon name="chevron" /></button><button className="text-button" onClick={() => { setPanel('files'); void refreshFiles(); }}>成果{files.length ? ` ${files.length}` : ''}</button></div>
          {snapshot ? <AgentConversation snapshot={snapshot} call={call} style={chatStyle} openFile={path => void openFile(path)} openExternal={openExternal} /> : null}
        </main>
        <form className="composer agent-composer" ref={composer} onSubmit={event => { event.preventDefault(); void send(); }}>
          <div className="composer-card">
          {skillMenu || candidates.length ? <div id="agent-skills" className="agent-completions" role="group" aria-label="可用 Skills">{(candidates.length ? candidates : snapshot?.skills ?? []).map(item => <button type="button" key={item.id} aria-pressed={skill === item.id} onPointerDown={event => event.preventDefault()} onClick={() => chooseSkill(item.id)}>{skillName(item.id)}<small>/{item.id}</small></button>)}</div> : null}
          <label htmlFor="agent-message">消息<span>{sending ? '发送中' : snapshot?.busy ? '可以先写下一条消息' : '随时提问或安排任务'}</span></label>
          {skill ? <div className="agent-selected-skill"><span>{skillName(skill)}</span><button type="button" className="icon-button" onClick={() => setSkill(null)} aria-label="取消 Skill 选择"><Icon name="close" /></button></div> : null}
          <textarea id="agent-message" ref={input} aria-label="发送消息" placeholder={skill ? '有什么需要特别关注的？' : '提问，或输入 / 选择 Skill'} value={draft} onChange={event => setDraft(event.target.value)} rows={2} onKeyDown={event => { if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); } }} />
          <div className="composer-controls"><button type="button" className="configuration-button" onClick={openSettings}><Icon name="settings" /><span>{model?.displayName || snapshot?.model || 'Codex'}{snapshot?.effort ? ` · ${snapshot.effort}` : ''}</span></button>
            <button type="button" className="icon-button" aria-label="选择 Skill" aria-expanded={skillMenu || Boolean(candidates.length)} aria-controls="agent-skills" disabled={opening} onPointerDown={event => event.preventDefault()} onClick={() => setSkillMenu(current => !current)}><Icon name="plus" /></button>
            <button type="button" className="icon-button hide-keyboard" aria-label="收起键盘" onPointerDown={event => event.preventDefault()} onClick={event => { input.current?.blur(); event.currentTarget.blur(); }}><Icon name="hideKeyboard" /></button>
            {snapshot?.busy ? <button type="button" className="send-button" aria-label="停止" onClick={() => void call('agent.cancel').catch(failure => setError(errorText(failure)))}><span className="agent-stop-mark" aria-hidden="true" /></button> : <button type="submit" className="send-button" aria-label="发送" disabled={!snapshot?.ready || opening || configuring || sending || (!draft.trim() && !skill)}><Icon name="send" /></button>}
          </div>
          </div>
        </form>
      </div>}
  </div>;
}
