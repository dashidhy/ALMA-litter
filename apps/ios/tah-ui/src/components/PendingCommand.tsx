import { createContext, useContext } from 'react';
import type { Command } from '../contract';

// UI request admission only. Model execution/progress stays native-owned.
export const PendingCommandContext = createContext<Command | null>(null);
const labels: Record<Command, string> = {
  selectProvider: 'Selecting provider…', authorizeProvider: 'Connecting provider…',
  requestAuthorizationReplacement: 'Preparing connection change…', confirmAuthorizationReplacement: 'Updating connection…',
  refresh: 'Refreshing…', inspectAuthorization: 'Checking connection…',
  selectTranscript: 'Opening transcript…', selectAction: 'Opening notes…',
  importTranscript: 'Importing transcript…', selectInteractionLanguage: 'Updating language…',
  checkRawSafety: 'Starting transcript check…', createStructuredNotesAction: 'Preparing notes…',
  sendAction: 'Submitting instructions…', loadMoreConversation: 'Loading earlier messages…',
  expandConversation: 'Loading message…', readMaterial: 'Opening material…',
  dismissMaterial: 'Returning to conversation…', checkpointDraft: 'Saving draft…',
  openWorkingLog: 'Opening working events…', refreshWorkingLog: 'Updating working events…',
  closeWorkingLog: 'Closing working events…', signIn: 'Connecting to ChatGPT…',
  openExternal: 'Opening link…',
};
export function PendingCommandStatus() {
  const command = useContext(PendingCommandContext);
  return command ? <p className="loading-line pending-command" role="status" aria-atomic="true">
    <span className="spinner" aria-hidden="true" />{labels[command]}
  </p> : null;
}
