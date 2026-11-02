// Render-only projection of TAHPresentationContract.swift. Native owns policy.
export type Language = 'en' | 'zh-CN';
export interface Choice { id: string; title: string; enabled: boolean }
export interface ContextWindow { id: number; title: string; enabled: boolean }
export interface RevisionSettings {
  providerID: string | null;
  modelID: string | null;
  reasoningEffortID: string | null;
  contextWindowTokens: number | null;
  webEnabled: boolean;
}
export interface Draft {
  outputLanguage: Language;
  settings: RevisionSettings;
  instructions: string;
  consent: boolean;
}
export interface EditorContext { actionID: string; editorToken: string }
export interface TimelineItem {
  id: string; title: string; text: string; markdown: boolean;
  detail: string | null; canExpand: boolean;
  role?: 'user' | 'assistant' | 'system';
  revisionIndex?: number;
  phase?: string;
  working?: WorkingSummary | null;
}
// Native projects the original TAH public event contract. No provider payloads.
export interface WorkingEvent {
  id: string; title: string; detail: string; role: string; kind: string;
  titleCode: string | null; status: string | null;
  detailTruncated: boolean; round: number | null;
}
export interface WorkingSummary {
  id: string; position: number | null; revisionIndex: number; phase: string;
  startedAt: string | null; endedAt: string | null;
  events: WorkingEvent[]; canOpen: boolean; live: boolean;
  progressing: boolean; criticPassed: boolean;
}
export interface WorkingLog {
  id: string; actionID: string; position: number | null; revisionIndex: number;
  startedAt: string | null; endedAt: string | null;
  events: WorkingEvent[]; criticPassed: boolean;
  loading: boolean; failed: boolean; limited: boolean;
  superseded: boolean; progressing: boolean; error: string | null;
}
export type WorkingLogMetadata = Omit<WorkingLog, 'events'>;
export interface WorkingStreamFrame {
  schemaVersion: 1;
  subscriptionID: number;
  sequence: number;
  baseSequence: number;
  reset: boolean;
  log: WorkingLogMetadata | null;
  events: WorkingEvent[];
  removed: string[];
  order: string[];
}
export interface WorkingSubscription {
  subscriptionID: number;
  ack(sequence: number): Promise<void>;
  unsubscribe(): Promise<void>;
}
/** null is supported only by explicit browser fixtures without a stream. */
export type SubscribeWorking = (onFrame: (frame: WorkingStreamFrame) => void) => Promise<WorkingSubscription | null>;
export interface Revision { id: string; revisionIndex: number; configurationLabel: string }
export interface Material {
  id: string; title: string; text: string | null; markdown: boolean;
  isLoading: boolean; error: string | null;
}
export interface Permissions {
  selectTranscript: boolean; importTranscript: boolean; selectAction: boolean;
  checkRaw: boolean; createAction: boolean; edit: boolean; editConsent: boolean;
  editInteractionLanguage: boolean; send: boolean; readMaterial: boolean; loadHistory: boolean;
}
export interface Presentation {
  transcripts: Choice[]; transcriptID: string | null; actions: Choice[];
  editor: EditorContext | null; models: Choice[]; efforts: Choice[]; contextWindows: ContextWindow[];
  interactionLanguage: Language; initialSettingsFrozen: boolean; canOmitInstructions: boolean;
  consentGranted: boolean; rawStatus: string; rawExplanation: string | null; rawValidityLabel: string | null;
  status: string; disabledReason: string | null; error: string | null; isBusy: boolean;
  timeline: TimelineItem[]; revisions: Revision[]; hasMoreHistory: boolean;
  material: Material | null; permissions: Permissions;
  currentActivity?: WorkingSummary | null;
  workingLog?: WorkingLog | null;
}
export interface Snapshot { presentation: Presentation; draft: Draft; ready?: boolean; error?: string | null }
export type OutcomeFile = 'structured-notes.md' | 'suspicious-asr-terms.md';
export type MaterialRequest =
  | { kind: 'rawTranscript'; actionID: string; revisionIndex: null; file: null }
  | { kind: 'outcome'; actionID: string; revisionIndex: number; file: OutcomeFile };
export interface Commands {
  snapshot: Record<string, never>;
  refresh: Record<string, never>;
  inspectAuthorization: Record<string, never>;
  selectTranscript: { id: string };
  selectAction: { id: string };
  importTranscript: { title: string; text: string };
  updateDraft: { draft: Draft; context: EditorContext | null };
  selectInteractionLanguage: { language: Language };
  checkRawSafety: { transcriptID: string; consent: boolean; interactionLanguage: Language };
  createStructuredNotesAction: { transcriptID: string; language: Language; settings: RevisionSettings };
  sendAction: {
    context: EditorContext; instructions: string; settings: RevisionSettings;
    initialLanguage: Language | null; interactionLanguage: Language; consent: boolean;
  };
  loadMoreConversation: { actionID: string };
  expandConversation: { actionID: string; itemID: string };
  readMaterial: MaterialRequest;
  dismissMaterial: Record<string, never>;
  checkpointDraft: Record<string, never>;
  openWorkingLog: { actionID: string; position: number | null };
  refreshWorkingLog: { id: string };
  closeWorkingLog: { id: string };
  signIn: Record<string, never>;
  openExternal: { url: string };
}
export type Method = keyof Commands;
export type Command = Exclude<Method, 'snapshot' | 'updateDraft'>;
/** Invalidations carry no state; consumers read the current projection after subscribing. */
export type SubscribeChanges = (changed: () => void) => Promise<() => void>;
export type Call = <M extends Method>(method: M, value: Commands[M]) => Promise<Snapshot>;
export function editorIdentity(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.presentation.transcriptID, snapshot.presentation.editor?.actionID,
    snapshot.presentation.editor?.editorToken]);
}
