import type { Material, MaterialRequest } from './contract';

/** The current native projection identifies its requested target by this title.
 * IDs are opaque and must also change for a newly admitted read. */
export function materialMatchesRequest(material: Material, request: MaterialRequest): boolean {
  const title = request.kind === 'rawTranscript' ? 'Raw transcript'
    : `v${request.revisionIndex} · ${request.file === 'structured-notes.md' ? 'Notes' : 'ASR terms'}`;
  return material.title === title;
}
