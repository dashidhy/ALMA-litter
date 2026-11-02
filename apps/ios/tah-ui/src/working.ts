import type { WorkingEvent } from './contract';

// Same public-event boundary as the read-only Mac reference. Never use titles
// to infer event roles, or render private/guardian reasoning payloads.
export function isPublicWorkingEvent(event: WorkingEvent): boolean {
  return event.role === 'actor' || (event.id === 'extra-safety-pass' && event.role === 'extra_guardian' &&
    event.kind === 'activity' && event.titleCode === 'safety_guardian' && event.status === 'pass');
}
export function completedPhase(phase: string | undefined): boolean {
  return phase === 'published' || phase === 'completed';
}
export function isGuardianPhase(phase: string): boolean {
  return ['raw_guardian', 'extra_guardian', 'saving_safety', 'raw_blocked', 'extra_blocked', 'raw_unavailable', 'extra_unavailable'].includes(phase);
}
export function workingDuration(start: string | null, end: string | null): string | null {
  const from = Date.parse(start ?? '');
  const to = Date.parse(end ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const seconds = Math.floor((to - from) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`
    : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
