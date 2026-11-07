import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MobileProviderAdapter } from '../provider.js';
import { nativeCall } from '../bridge.js';
import { projectKimiCatalog, projectKimiUsage } from './adopted/auth-driver.js';
import { kimiProfile } from './adopted/policy.js';
import { NormalizedEventLedgerV1, normalizedEventSchema, attemptTerminalSchema } from '../../upstream/src/contract/events.js';
import { parseFrozenAttempt, compareCanonicalUTF8V1, type AttemptTerminalV1 } from '../../upstream/src/contract/index.js';
import { AuthOperationError } from '../../upstream/src/auth-prototype/protocol.js';
import type { BuiltAttemptV1 } from '../../upstream/src/framework/attempt-builders.js';

const scopeSchema = z.strictObject({ handle: z.uuid(), workspaceRoot: z.string().startsWith('/workspace/'), scratchRoot: z.string().startsWith('/workspace/') });
const inspectionSchema = z.strictObject({ state: z.enum(['valid', 'invalid']), credentialHandle: z.uuid().nullable(), models: z.unknown(), usages: z.unknown() });
const captureSchema = z.strictObject({ scopeID: z.uuid(), quiescent: z.literal(true), entries: z.array(z.strictObject({
  relativePath: z.string(), kind: z.enum(['file', 'directory']), byteLength: z.number().int().nonnegative().nullable(), base64: z.string().nullable(),
})).max(512) });

function assertClosed(receipt: any) {
  if (receipt?.runtimeClosed !== true || receipt.requestsJoined !== true || receipt.eventsRetained !== true || receipt.scopeQuiescent !== true) {
    throw new AuthOperationError('cleanup');
  }
}

function serializeInput(built: BuiltAttemptV1) {
  const files = [...built.attempt.workspace.materials, ...built.attempt.workspace.candidateSeeds.filter(seed => seed.kind === 'file')]
    .sort((a, b) => compareCanonicalUTF8V1(a.relativePath, b.relativePath));
  if (files.length !== built.inputBytes.size) throw new Error('Unexpected input files');
  return files.map(meta => {
    const bytes = built.inputBytes.get(meta.relativePath);
    if (!bytes || bytes.byteLength !== meta.byteLength || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
      throw new Error('Frozen input identity mismatch');
    }
    return { relativePath: meta.relativePath, base64: Buffer.from(bytes).toString('base64') };
  });
}

export const mobileKimiProvider: MobileProviderAdapter = {
  id: 'kimi',
  async authenticate(context) {
    if (context.providerID !== 'kimi') throw new AuthOperationError('protocol');
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const receipt = inspectionSchema.parse(await nativeCall('provider.kimi.inspect', {
      kind: context.kind, credentialHandle: context.credential ? Buffer.from(context.credential).toString('utf8') : null,
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown })?.code;
      if (code === 'provider_cleanup' || code === 'cleanup') throw new AuthOperationError('cleanup');
      if (code === 'provider_timeout' || code === 'timeout') throw new AuthOperationError('timeout');
      throw new AuthOperationError('unavailable');
    }));
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (receipt.state === 'invalid') return { state: 'invalid', credential: null, account: null,
      catalog: null, catalogUnavailable: false, accountUsage: null, accountUsageUnavailable: false };
    const credential = Buffer.from(z.uuid().parse(receipt.credentialHandle), 'utf8');
    let catalog = null, accountUsage = null;
    // Same projections and unavailable semantics as the adopted Mac auth driver.
    try { catalog = projectKimiCatalog(receipt.models); } catch { /* No invented models. */ }
    try { accountUsage = projectKimiUsage(receipt.usages); } catch { /* Usage may be unavailable. */ }
    return { state: 'valid', credential, account: 'Kimi Code', catalog, catalogUnavailable: catalog === null,
      accountUsage, accountUsageUnavailable: accountUsage === null };
  },
  async run(built, credential, onEvent, signal) {
    parseFrozenAttempt(built.attempt);
    kimiProfile(built.attempt);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const scope = scopeSchema.parse(await nativeCall('provider.kimi.prepare', {
      attempt: built.attempt, inputFiles: serializeInput(built), credentialHandle: z.uuid().parse(Buffer.from(credential).toString('utf8')),
    }));
    const call = <T = any>(operation: string) => nativeCall<T>(`provider.kimi.${operation}`, { handle: scope.handle })
      .catch((error: unknown) => {
        if (operation === 'close' || operation === 'release') throw new AuthOperationError('cleanup');
        throw error;
      });
    const ledger = new NormalizedEventLedgerV1(built.attempt.attemptID);
    let cancelTask: Promise<unknown> | undefined;
    let cancelError: unknown;
    let closed = false;
    const cancel = () => {
      cancelTask ??= call('cancel').catch(error => { cancelError = error; });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      await call('start');
      let terminal: AttemptTerminalV1;
      for (;;) {
        const result = await call('nextEvent');
        if (result.done === true) { terminal = attemptTerminalSchema.parse(result.terminal); break; }
        if (result.done !== false) throw new AuthOperationError('protocol');
        const event = normalizedEventSchema.parse(result.event);
        ledger.observe(event);
        await onEvent?.(event);
      }
      await cancelTask;
      if (terminal.kind === 'failed' && terminal.failure.family === 'cleanup') throw new AuthOperationError('cleanup');
      if (cancelError) throw cancelError;
      ledger.assertTerminal(terminal);
      assertClosed(await call('close'));
      closed = true;
      const capture = captureSchema.parse(await call('capture'));
      if (capture.scopeID !== scope.handle) throw new Error('Candidate scope mismatch');
      const files = new Map<string, Uint8Array>();
      const seen = new Set<string>();
      let total = 0;
      const manifest = capture.entries.map(entry => {
        const path = entry.relativePath;
        if (seen.has(path) || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)
          || path.split('/').some(part => !part || part === '.' || part === '..')
          || !built.attempt.workspace.writableRoots.some(root => path === root || path.startsWith(`${root}/`))) {
          throw new Error('Invalid candidate path');
        }
        seen.add(path);
        if (entry.kind === 'file') {
          if (entry.base64 === null) throw new Error('Invalid candidate file');
          const bytes = Buffer.from(entry.base64, 'base64');
          total += bytes.byteLength;
          if (bytes.toString('base64') !== entry.base64 || bytes.byteLength !== entry.byteLength || total > 64 * 1024 * 1024) {
            throw new Error('Candidate bytes mismatch');
          }
          files.set(path, bytes);
        } else if (entry.base64 !== null || entry.byteLength !== null) throw new Error('Invalid candidate directory');
        return { relativePath: path, kind: entry.kind, byteLength: entry.byteLength };
      });
      return { terminal, candidateManifest: manifest, candidateFiles: files };
    } finally {
      signal.removeEventListener('abort', cancel);
      // Malformed events and observer errors must drain the guest before release.
      try {
        if (!closed) { cancel(); await cancelTask; assertClosed(await call('close')); }
      } finally { await call('release'); }
    }
  },
};
