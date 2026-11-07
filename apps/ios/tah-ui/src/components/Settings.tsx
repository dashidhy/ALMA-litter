import type { Draft, Language, Presentation } from '../contract';
import type { UIController } from '../controller';
import { Sheet } from './Sheet';
import type { ChatStyle } from '../chatStyle';

export function Settings({ p, draft, controller, disabled, error, theme, setTheme, chatStyle, setChatStyle, close }: {
  p: Presentation; draft: Draft; controller: UIController; disabled: boolean;
  error: string | null; theme: 'ink' | 'paper'; setTheme: (theme: 'ink' | 'paper') => void; close: () => void;
  chatStyle: ChatStyle; setChatStyle: (style: ChatStyle) => void;
}) {
  const update = (patch: Partial<Draft>) => controller.editSettings({ ...draft, ...patch });
  const settings = (patch: Partial<Draft['settings']>) => update({ settings: { ...draft.settings, ...patch } });
  const auth = p.authorization;
  const providerName = auth?.providers.find(provider => provider.id === auth.providerID)?.title || auth?.providerID || 'provider';
  const replacement = auth?.replacement;
  const replacementProvider = auth?.providers.find(provider => provider.id === replacement?.providerID)?.title || replacement?.providerID;
  return <Sheet title="Settings" close={close}>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {auth ? <section className="settings-section"><h3>Provider connection</h3>
      <label className="field">Provider<select aria-label="Provider" value={auth.providerID ?? ''} disabled={disabled || !auth.canManage}
        onChange={event => { void controller.run('selectProvider', { providerID: event.target.value }); }}>
        <option value="" disabled>Choose a provider</option>
        {auth.providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled}>{provider.title || provider.id}</option>)}
      </select></label>
      <p className="hint" role="status">{auth.phase === 'authorizing' ? `Connecting to ${providerName}…`
        : auth.inspecting ? 'Checking authorization and models…' : auth.state === 'valid' ? `Connected to ${providerName}`
          : auth.state === 'invalid' ? 'Authorization needs attention.' : `Connect ${providerName} to start processing.`}</p>
      {auth.account ? <p className="hint">{auth.account}</p> : null}
      {auth.noticeCode ? <p className="hint">{auth.noticeCode.replaceAll('_', ' ')}</p> : null}
      {replacement ? <div role="group" aria-label="Confirm provider change">
        <p>{replacement.kind === 'switch_provider' ? `Switch to ${replacementProvider}?` : replacement.kind === 'sign_out' ? `Disconnect ${providerName}?` : `Replace the ${providerName} connection?`}</p>
        <p className="hint">This replaces the active provider connection. Your saved notes and transcripts stay available.</p>
        <button className="row-button" disabled={disabled || !auth.canConfirmReplacement} onClick={() => { void controller.run('confirmAuthorizationReplacement', { id: replacement.id, confirmed: true }); }}>Confirm connection change</button>
        <button className="row-button" disabled={disabled || !auth.canConfirmReplacement} onClick={() => { void controller.run('confirmAuthorizationReplacement', { id: replacement.id, confirmed: false }); }}>Keep current connection</button>
      </div> : <>
        <button className="row-button" disabled={disabled || !auth.canManage || !auth.providerID}
          onClick={() => { void controller.run('authorizeProvider', {}); }}>{auth.state === 'unauthed' ? (auth.providerID === 'codex' ? 'Sign in with ChatGPT' : `Connect ${providerName}`) : 'Replace connection'}</button>
        <button className="row-button" disabled={disabled || !auth.canManage || auth.state !== 'valid'}
          onClick={() => { void controller.run('inspectAuthorization', {}); }}>Inspect authorization</button>
        {auth.state !== 'unauthed' ? <button className="row-button" disabled={disabled || !auth.canManage}
          onClick={() => { void controller.run('requestAuthorizationReplacement', { kind: 'sign_out' }); }}>Disconnect provider</button> : null}
        {auth.providerID === 'zcode' ? <p className="hint">Connect opens BigModel’s official sign-in page. Your Coding Plan credentials are stored in this device’s Keychain.</p> : null}
        {auth.providerID === 'kimi' ? <p className="hint">Connect opens a native secure entry dialog. Your API key is stored in this device’s Keychain.</p> : null}
      </>}
    </section> : null}
    <section className="settings-section"><h3>Reading appearance</h3>
      <div className="segmented"><button aria-pressed={theme === 'ink'} onClick={() => setTheme('ink')}>Ink</button><button aria-pressed={theme === 'paper'} onClick={() => setTheme('paper')}>Paper</button></div>
    </section>
    <section className="settings-section"><h3>Conversation style</h3>
      <div className="segmented" role="group" aria-label="Conversation style">
        <button aria-pressed={chatStyle === 'bubbles'} onClick={() => setChatStyle('bubbles')}>Double bubbles</button>
        <button aria-pressed={chatStyle === 'light'} onClick={() => setChatStyle('light')}>Lightweight</button>
      </div>
    </section>
    <section className="settings-section"><h3>Language</h3>
      <label className="field">Interaction language<select value={p.interactionLanguage} disabled={disabled || !p.permissions.editInteractionLanguage}
        onChange={e => { void controller.run('selectInteractionLanguage', { language: e.target.value as Language }); }}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <label className="field">Notes language<select value={draft.outputLanguage} disabled={disabled || !p.permissions.edit || p.initialSettingsFrozen}
        onChange={e => update({ outputLanguage: e.target.value as Language })}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
      <p className="hint">{p.initialSettingsFrozen && p.editor ? 'Notes language is fixed after the first send.' : 'Choose the notes language before the first send.'}</p>
    </section>
    <section className="settings-section"><h3>Next revision</h3>
      {draft.settings.providerID ? <p className="hint">Provider · {draft.settings.providerID}</p> : null}
      <label className="field">Model<select value={draft.settings.modelID ?? ''} disabled={disabled || !p.permissions.edit || !p.models.length}
        onChange={e => settings({ modelID: e.target.value || null })}>
        <option value="" disabled>Select model</option>
        {draft.settings.modelID && !p.models.some(m => m.id === draft.settings.modelID) ? <option value={draft.settings.modelID} disabled>{draft.settings.modelID} · unavailable</option> : null}
        {p.models.map(model => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.title.trim() || model.id}</option>)}
      </select></label>
      <label className="field">Reasoning<select value={draft.settings.reasoningEffortID ?? ''} disabled={disabled || !p.permissions.edit || !p.efforts.length}
        onChange={e => settings({ reasoningEffortID: e.target.value || null })}>
        <option value="" disabled>{p.efforts.length ? 'Select reasoning level' : 'Not specified by provider'}</option>
        {draft.settings.reasoningEffortID && !p.efforts.some(e => e.id === draft.settings.reasoningEffortID) ? <option value={draft.settings.reasoningEffortID} disabled>{draft.settings.reasoningEffortID} · unavailable</option> : null}
        {p.efforts.map(effort => <option key={effort.id} value={effort.id} disabled={!effort.enabled}>{effort.id}</option>)}
      </select></label>
      {p.contextWindows.length || draft.settings.contextWindowTokens !== null ? <label className="field">Context window<select value={draft.settings.contextWindowTokens ?? ''} disabled={disabled || !p.permissions.edit || !p.contextWindows.length}
        onChange={e => settings({ contextWindowTokens: e.target.value ? Number(e.target.value) : null })}>
        <option value="">Provider default</option>
        {draft.settings.contextWindowTokens !== null && !p.contextWindows.some(w => w.id === draft.settings.contextWindowTokens) ? <option value={draft.settings.contextWindowTokens} disabled>{draft.settings.contextWindowTokens} · unavailable</option> : null}
        {p.contextWindows.map(window => <option key={window.id} value={window.id} disabled={!window.enabled}>{window.title}</option>)}
      </select></label> : null}
      <label className="toggle-row"><span>Web access</span><input type="checkbox" role="switch" checked={draft.settings.webEnabled} disabled={disabled || !p.permissions.edit} onChange={e => settings({ webEnabled: e.target.checked })} /></label>
      {!p.models.length ? <p className="hint">Inspect authorization to load the provider’s model catalog.</p> : null}
    </section>
    {!auth ? <section className="settings-section"><h3>Provider connection</h3>
      <button className="row-button" disabled={disabled || p.isBusy} onClick={() => { void controller.run('inspectAuthorization', {}); }}>Inspect authorization</button>
    </section> : null}
  </Sheet>;
}
