import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { parseFrozenAttempt } from '../../../upstream/src/contract/attempt.js';
import { NormalizedEventLedgerV1, normalizedEventSchema, attemptTerminalSchema } from '../../../upstream/src/contract/events.js';
import { KimiGuestAdapterV1 } from './adapter.js';
import type { KimiSDK } from '../adopted/native-sdk.js';

export const PLACEHOLDER_KEY = 'sk-alma-native-placeholder-000000000000';
const root = z.string().refine(value => isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\u0000-\u001f]/u.test(value));
const startSchema = z.strictObject({ kind: z.literal('start'), attempt: z.unknown(), workspaceRoot: root, scratchRoot: root });

export function parseStart(value: unknown) {
  const frame = startSchema.parse(value);
  if (frame.workspaceRoot === frame.scratchRoot || frame.workspaceRoot.startsWith(`${frame.scratchRoot}/`)
    || frame.scratchRoot.startsWith(`${frame.workspaceRoot}/`)) throw new Error('kimi_overlapping_roots');
  const attempt = parseFrozenAttempt(frame.attempt);
  if (attempt.providerID !== 'kimi') throw new Error('kimi_wrong_provider');
  return { ...frame, attempt };
}

export async function runKimiGuest(frame: ReturnType<typeof parseStart>, signal: AbortSignal,
  send: (frame: object) => void, loadSDK: () => Promise<KimiSDK>) {
  const adapter = new KimiGuestAdapterV1({ home: `${frame.scratchRoot}/home`, workspaceRoot: frame.workspaceRoot, loadSDK });
  const ledger = new NormalizedEventLedgerV1(frame.attempt.attemptID);
  let sequence = 0, consumed = false;
  const terminal = attemptTerminalSchema.parse(await adapter.run({ attempt: frame.attempt, signal,
    credential: { byteLength: Buffer.byteLength(PLACEHOLDER_KEY), consume() {
      if (consumed) throw new Error('kimi_credential_already_consumed');
      consumed = true;
      return Buffer.from(PLACEHOLDER_KEY);
    } },
    workspace: { listMaterials: () => frame.attempt.workspace.materials,
      readMaterial() { throw new Error('kimi_uses_native_workspace_tools'); },
      putCandidate() { throw new Error('kimi_uses_native_workspace_tools'); } },
    emit(value) {
      const event = normalizedEventSchema.parse({ ...value, attemptID: frame.attempt.attemptID, sequence: ++sequence });
      ledger.observe(event);
      send({ kind: 'event', event });
    },
  }));
  ledger.assertTerminal(terminal);
  send({ kind: 'terminal', terminal });
  return terminal;
}
