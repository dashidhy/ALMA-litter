import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, setNativeTheme, subscribeChanges, subscribeWorking } from './bridge';
import type { MaterialRequest } from './contract';
import { selectionIdentity, UIController } from './controller';
import type { UIState } from './controller';
import { Conversation } from './components/Conversation';
import { WorkingLogPanel } from './components/WorkingLogPanel';
import { loadChatStyle, saveChatStyle } from './chatStyle';
import { loadReadingTheme, saveReadingTheme } from './readingTheme';
import type { ChatStyle } from './chatStyle';
import { Icon } from './components/Icon';
import { PendingCommandContext, PendingCommandStatus } from './components/PendingCommand';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import type { Reading } from './components/Reader';
import { Settings } from './components/Settings';
import { useComposerInset, useViewport } from './useViewport';

const phases: Record<string, string> = {
  draft: 'Ready to create notes', preparing: 'Preparing', raw_guardian: 'Checking transcript',
  extra_guardian: 'Checking revision instructions', actor: 'Creating notes', critic: 'Checking results',
  saving_safety: 'Saving safety check', persistence_pending: 'Waiting to save',
  completed: 'Completed', published: 'Completed', editing: 'Ready for your revision',
  integrity_locked: 'This action needs attention', actor_failed: 'The action could not finish',
};
function Errors({ state }: { state: UIState }) {
  const errors = [...new Set([state.connectionError, state.commandError, state.snapshot?.presentation.error].filter(Boolean))];
  return errors.length ? <div className="errors" role="alert">{errors.map(error => <p key={error}>{error}</p>)}</div> : null;
}
function Workspace({ state, controller, openLibrary, openSettings, chatStyle }: {
  state: UIState; controller: UIController; openLibrary: () => void; openSettings: () => void; chatStyle: ChatStyle;
}) {
  const p = state.snapshot!.presentation;
  const draft = state.draft!;
  const disabled = state.pending !== null || Boolean(state.connectionError);
  const [reading, setReading] = useState<Reading | null>(null);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
  const { area, composer } = useComposerInset(Boolean(p.editor) && !reading);
  const transcript = p.transcripts.find(t => t.id === p.transcriptID);
  async function read(request: MaterialRequest) {
    if (await controller.run('readMaterial', request)) {
      // run only succeeds when native admits a new material matching this target.
      setReading({ request, materialID: controller.getSnapshot().snapshot?.presentation.material?.id ?? null });
    }
  }
  if (reading) return <><Errors state={state} /><Reader p={p} reading={reading} disabled={disabled} read={request => { void read(request); }} close={async () => {
    if (await controller.run('dismissMaterial', {})) setReading(null);
  }} /></>;
  return <>
    <header className="app-header"><button className="icon-button" aria-label="Open transcript library" onClick={openLibrary}><Icon name="library" /></button>
      <h1>Structured Notes</h1><button className="icon-button" aria-label="Open settings" onClick={openSettings}><Icon name="settings" /></button></header>
    <div className="work-area" ref={area}>
    <main className={`workspace-scroll${p.editor ? ' has-composer' : ''}`}>
      <button className="source-row" onClick={openLibrary}><Icon name="document" /><span><small>TRANSCRIPT</small><strong>{transcript?.title ?? 'Choose a transcript'}</strong></span><Icon name="chevron" /></button>
      <Errors state={state} />
      {p.disabledReason ? <p className="notice">{p.disabledReason}</p> : null}
      <div className="action-row"><label className="sr-only" htmlFor="selected-action">Saved action</label><select id="selected-action" value={p.editor?.actionID ?? ''} disabled={disabled || !p.permissions.selectAction || !p.actions.length}
        onChange={e => { void controller.run('selectAction', { id: e.target.value }); }}>
        <option value="" disabled>{p.actions.length ? 'Choose an action' : 'No actions yet'}</option>
        {p.actions.map(action => <option key={action.id} value={action.id} disabled={!action.enabled}>{action.title}</option>)}
      </select><button className="icon-button outlined" aria-label="New Structured Notes" title="New Structured Notes" disabled={disabled || !p.permissions.createAction || !p.transcriptID}
        onClick={() => { void controller.run('createStructuredNotesAction', (snapshot, current) => ({ transcriptID: snapshot.presentation.transcriptID!, language: current.outputLanguage, settings: current.settings })); }}><Icon name="plus" /></button></div>
      <details className="safety-panel" open={!p.editor || undefined}>
        <summary><span>{p.rawStatus}</span><span className="summary-plus" aria-hidden="true">+</span></summary>
        <div className="safety-content">
          {p.rawExplanation ? <p className="literal-text hint">{p.rawExplanation}</p> : null}
          {p.rawValidityLabel ? <p className="hint">{p.rawValidityLabel}</p> : null}
          {p.consentGranted ? <p className="hint consent-granted"><Icon name="check" />Processing consent granted</p> : <label className="consent-row"><input type="checkbox" checked={draft.consent} disabled={disabled || !p.permissions.editConsent}
            onChange={e => controller.edit({ ...draft, consent: e.target.checked })} /><span>Allow the selected provider to process this transcript, instructions, and prior outcomes.</span></label>}
          <div className="button-row"><button className="secondary" disabled={disabled || !p.permissions.checkRaw || !p.transcriptID} onClick={() => { void controller.run('checkRawSafety', (snapshot, current) => ({ transcriptID: snapshot.presentation.transcriptID!, consent: current.consent, interactionLanguage: snapshot.presentation.interactionLanguage })); }}>Check transcript</button>
            {p.editor ? <button className="text-button" disabled={disabled || !p.permissions.readMaterial} onClick={() => { void read({ kind: 'rawTranscript', actionID: p.editor!.actionID, revisionIndex: null, file: null }); }}>Read source</button> : null}</div>
        </div>
      </details>
      {p.status || p.isBusy ? <div className="phase-row" role="status">{p.isBusy ? <span className="spinner" aria-hidden="true" /> : <span className="status-dot" />}<span>{phases[p.status] ?? (p.status.trim() || 'Processing…')}</span></div> : null}
      {p.editor ? <Conversation p={p} controller={controller} disabled={disabled} style={chatStyle} read={request => { void read(request); }} /> : <div className="empty-state"><h2>{p.transcriptID ? 'Make room for the useful parts.' : 'Start with a transcript.'}</h2><p>{p.transcriptID ? 'Check the transcript, then open a saved action or create Structured Notes.' : 'Choose from your library or import the full text.'}</p>
        {p.transcriptID ? <button className="primary" disabled={disabled || !p.permissions.createAction} onClick={() => { void controller.run('createStructuredNotesAction', (snapshot, current) => ({ transcriptID: snapshot.presentation.transcriptID!, language: current.outputLanguage, settings: current.settings })); }}><Icon name="plus" />New Structured Notes</button> : <button className="primary" onClick={openLibrary}><Icon name="library" />Open library</button>}
      </div>}
    </main>
    {p.editor ? <form className="composer" ref={composer} onSubmit={e => { e.preventDefault(); void controller.send(); }}>
      <div className="composer-card">
      <label htmlFor="instructions">{p.canOmitInstructions ? 'Instructions' : 'Revision instructions'}<span>{p.canOmitInstructions ? 'Optional for v0' : 'Required'}</span></label>
      <textarea id="instructions" ref={instructionsInput} rows={2} placeholder={p.canOmitInstructions ? 'Anything to focus on?' : 'What should change?'} value={draft.instructions} disabled={disabled || !p.permissions.edit}
        onChange={e => controller.edit({ ...draft, instructions: e.target.value })} />
      <div className="composer-controls"><button type="button" className="configuration-button" onClick={openSettings}><Icon name="settings" /><span>{p.models.find(model => model.id === draft.settings.modelID)?.title.trim() || draft.settings.modelID || 'Choose a model'}{draft.settings.reasoningEffortID ? ` · ${draft.settings.reasoningEffortID}` : ''}</span></button>
        <button type="button" className="icon-button hide-keyboard" aria-label="Hide keyboard" onPointerDown={event => event.preventDefault()}
          onClick={event => { instructionsInput.current?.blur(); event.currentTarget.blur(); }}><Icon name="hideKeyboard" /></button>
        <button className="send-button" aria-label={p.canOmitInstructions ? 'Send to create notes' : 'Send revision'} type="submit" disabled={disabled || !p.permissions.send || (!p.canOmitInstructions && !draft.instructions.trim())}><Icon name="send" /></button></div>
      </div>
    </form> : <footer className="home-footer"><span>alma</span><button className="text-button" disabled={disabled || p.isBusy} onClick={() => { if (p.authorization?.state !== 'valid') openSettings(); else void controller.run('inspectAuthorization', {}); }}>{p.authorization?.state === 'valid' ? 'Inspect authorization' : 'Connect a provider'}</button></footer>}
    </div>
    {state.workingLogID && p.editor ? <WorkingLogPanel key={state.workingLogID} id={state.workingLogID} actionID={p.editor.actionID} log={state.workingLog === undefined ? p.workingLog : state.workingLog}
      pending={state.pending !== null} error={state.commandError || state.connectionError || state.workingStreamError}
      close={() => { void controller.closeWorkingLog(state.workingLogID!); }}
      refresh={() => { void controller.run('refreshWorkingLog', { id: state.workingLogID! }); }} /> : null}
  </>;
}

export default function App({ controller: supplied }: { controller?: UIController }) {
  const shell = useViewport();
  const [controller] = useState(() => supplied ?? new UIController(call, subscribeChanges, subscribeWorking));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [sheet, setSheet] = useState<'library' | 'settings' | null>(null);
  const [theme, setTheme] = useState(loadReadingTheme);
  const [chatStyle, setChatStyle] = useState(loadChatStyle);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [importTitle, setImportTitle] = useState('');
  const [importText, setImportText] = useState('');
  useEffect(() => controller.start(), [controller]);
  useEffect(() => {
    let active = true;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'ink' ? '#131613' : '#faf7ef');
    setThemeError(null);
    void setNativeTheme(theme === 'ink').catch(error => {
      if (active) setThemeError(error instanceof Error ? error.message : 'Could not update the native theme.');
    });
    return () => { active = false; };
  }, [theme]);
  useEffect(() => {
    const checkpoint = () => {
      const current = controller.getSnapshot();
      if (document.visibilityState === 'hidden' && current.snapshot?.ready !== false && !current.snapshot?.presentation.isBusy && !current.pending) void controller.checkpoint();
    };
    document.addEventListener('visibilitychange', checkpoint);
    return () => document.removeEventListener('visibilitychange', checkpoint);
  }, [controller]);
  const p = state.snapshot?.presentation;
  const notReady = !p || !state.draft || state.snapshot?.ready === false;
  return <PendingCommandContext value={state.pending}><div className="app-shell" ref={shell}>
    {import.meta.env.DEV && window.__TAH_UI_FIXTURE__ ? <div className="fixture-banner">Preview data · 预览数据 · no live processing</div> : null}
    {themeError ? <p className="error" role="alert">{themeError}</p> : null}
    <PendingCommandStatus />
    {!notReady && state.connectionError ? <button className="row-button reconnect-button" disabled={state.pending !== null} onClick={() => { void controller.run('refresh', {}); }}>Reconnect to native workspace</button> : null}
    {notReady ? <><header className="app-header"><span className="header-mark">alma</span><h1>Structured Notes</h1><span /></header>
      <main className="connection-page"><h2>{state.connectionError || state.snapshot?.error ? 'Connect to Alma' : 'Preparing your workspace'}</h2><Errors state={state} />
        {p?.isBusy && !state.connectionError ? <p className="loading-line" role="status"><span className="spinner" aria-hidden="true" />{phases[p.status] ?? (p.status.trim() || 'Preparing…')}</p> : null}
        <div className="connection-actions"><button className="secondary" disabled={state.pending !== null} onClick={() => { void controller.run('refresh', {}); }}>Reconnect</button></div>
      </main></> : <Workspace key={selectionIdentity(state.snapshot!)} state={state} controller={controller} chatStyle={chatStyle} openLibrary={() => setSheet('library')} openSettings={() => setSheet('settings')} />}
    {!notReady && sheet === 'library' ? <Library p={p!} controller={controller} disabled={state.pending !== null || Boolean(state.connectionError)} error={state.commandError || state.connectionError || p!.error} title={importTitle} text={importText} setTitle={setImportTitle} setText={setImportText} close={() => setSheet(null)} /> : null}
    {!notReady && sheet === 'settings' ? <Settings p={p!} draft={state.draft!} controller={controller} disabled={state.pending !== null || Boolean(state.connectionError)} error={state.commandError || state.connectionError || p!.error || themeError} theme={theme} chatStyle={chatStyle} setChatStyle={next => { setChatStyle(next); saveChatStyle(next); }} setTheme={next => {
      saveReadingTheme(next); setTheme(next);
    }} close={() => setSheet(null)} /> : null}
  </div></PendingCommandContext>;
}
