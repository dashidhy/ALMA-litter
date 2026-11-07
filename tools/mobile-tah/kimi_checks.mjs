import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import net from 'node:net';

const root = fileURLToPath(new URL('../../shared/tah-runtime/', import.meta.url));
const nativeRequire = createRequire(import.meta.url), cache = new Map();
function load(id) {
  if (id.startsWith('node:')) return nativeRequire(id);
  if (id === 'zod') return nativeRequire(path.join(root, 'vendor/zod/index.cjs'));
  if (cache.has(id)) return cache.get(id).exports;
  const module = { exports: {} };
  cache.set(id, module);
  const source = fs.readFileSync(id, 'utf8');
  const code = ts.transpileModule(source, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, spec => load(spec.startsWith('.')
    ? path.resolve(path.dirname(id), spec).replace(/\.js$/, '.ts') : spec));
  return module.exports;
}
const { parseStart, runKimiGuest, PLACEHOLDER_KEY } = load(path.join(root, 'platform/kimi/guest/runner.ts'));
const { mobileKimiProvider } = load(path.join(root, 'platform/kimi/mobile-provider.ts'));
const { mobileCodexProvider } = load(path.join(root, 'platform/codex/mobile-provider.ts'));
const { mobileAttemptPort } = load(path.join(root, 'platform/attempt-port.ts'));
const { AuthService } = load(path.join(root, 'upstream/src/auth-prototype/service.ts'));
const { AuthOperationError } = load(path.join(root, 'upstream/src/auth-prototype/protocol.ts'));
const { BoundedTahHostOperationSchedulerV1 } = load(path.join(root, 'upstream/src/host/operation-scheduler.ts'));
const { TahAttemptExecutionErrorV1 } = load(path.join(root, 'upstream/src/framework/workflow.ts'));
const { createPipeFetch } = load(path.join(root, 'platform/kimi/guest/pipe-fetch.ts'));
const { TAH_ACTOR_ABILITIES, TAH_GUARDIAN_ABILITIES } = load(path.join(root, 'upstream/src/contract/abilities.ts'));
const { NormalizedEventLedgerV1 } = load(path.join(root, 'upstream/src/contract/events.ts'));
const sdkPath = fileURLToPath(new URL('../kimi-mobile-probe/.cache/latest-release/artifact/opt/kimi/sdk/index.mjs', import.meta.url));
const fetchPath = fileURLToPath(new URL('../kimi-mobile-probe/.cache/latest-release/source/node_modules/.pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js', import.meta.url));
const bindings = await import(pathToFileURL(fetchPath).href);
for (const name of ['Headers', 'Request', 'Response', 'FormData']) globalThis[name] = bindings[name];
const denyNetwork = () => { throw Error('Unexpected fixture network'); };
net.connect = denyNetwork;
net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
const marker = 'ALMA_FIXTURE_KIMI: Alice Friday; Bob Thursday; budget 500.';
const note = '# Notes\nAlice Friday. Bob Thursday. Budget 500. 中文 🧪\n';
function attempt(role = 'actor', web = false) {
  return { contractVersion: 1, attemptID: randomUUID(), providerID: 'kimi', role,
    inference: { modelID: 'kimi-for-coding', reasoningEffortID: 'low' },
    prompt: [{ authority: 'tah_instruction', text: 'Read input.txt. For an actor write out/notes.md. For a guardian return JSON.' }],
    workspace: { materials: [{ relativePath: 'input.txt', mediaType: 'text/plain', byteLength: Buffer.byteLength(marker), sha256: createHash('sha256').update(marker).digest('hex') }], candidateSeeds: [], writableRoots: role === 'actor' ? ['out'] : [] },
    responseExpectation: role === 'actor' ? { kind: 'workspace_outcome', contractID: 'fixture/v1', maximumFinalMessageUTF8Bytes: 4096 }
      : { kind: 'strict_json', schemaID: 'fixture/v1', maximumUTF8Bytes: 4096 },
    requiredAbilities: [...(role === 'actor' ? TAH_ACTOR_ABILITIES : TAH_GUARDIAN_ABILITIES), ...(web ? ['web'] : [])] };
}
async function fixture(role, mode = 'complete', {
  loadSDK = () => import(pathToFileURL(sdkPath).href),
  expectedTerminal = mode === 'cancel' ? 'cancelled' : 'end_turn',
  onFrame = () => {},
} = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alma-kimi-')));
  const workspaceRoot = path.join(directory, 'workspace'), scratchRoot = path.join(directory, 'scratch');
  fs.mkdirSync(workspaceRoot); fs.mkdirSync(scratchRoot); fs.mkdirSync(path.join(workspaceRoot, 'out'));
  fs.writeFileSync(path.join(workspaceRoot, 'input.txt'), marker);
  const frames = [], controller = new AbortController();
  const frozen = attempt(role, mode === 'web');
  const frame = parseStart({ kind: 'start', attempt: frozen, workspaceRoot, scratchRoot });
  let requests = 0, roundTrip = false;
  const webRequests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.kimi.com/coding/v1/search') {
      webRequests.push('search');
      assert.equal(JSON.parse(init.body).text_query, 'fixture facts');
      return new Response(JSON.stringify({ search_results: [{ title: 'Fixture', url: 'https://example.com/fixture', snippet: 'Verified facts' }] }));
    }
    if (String(url) === 'https://api.kimi.com/coding/v1/fetch') {
      webRequests.push('fetch');
      assert.equal(JSON.parse(init.body).url, 'https://example.com/fixture');
      return new Response('Verified fixture facts');
    }
    assert.equal(String(url), 'https://api.kimi.com/coding/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${PLACEHOLDER_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'kimi-for-coding');
    const config = fs.readFileSync(path.join(scratchRoot, 'home/config.toml'), 'utf8');
    assert.ok(config.includes(PLACEHOLDER_KEY));
    assert.ok(config.includes('[database]\nbase = false\nsearch = false\n'));
    requests++;
    if (mode === 'cancel') {
      setTimeout(() => controller.abort(), 10);
      return new Promise((resolve, reject) => {
        const stop = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init.signal.aborted) stop(); else init.signal.addEventListener('abort', stop, { once: true });
      });
    }
    if (requests === 2) {
      roundTrip = body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(marker));
      assert.ok(roundTrip, 'real Read result reaches the next model request');
    }
    const operations = [['Read', { path: workspaceRoot + '/input.txt' }]];
    if (role === 'actor') operations.push(['Write', { path: workspaceRoot + '/out/notes.md', content: note }]);
    if (mode === 'read-missing') operations.splice(1, 0, ['Read', { path: workspaceRoot + '/out/notes.md' }]);
    if (mode === 'web') operations.push(['WebSearch', { query: 'fixture facts' }], ['FetchURL', { url: 'https://example.com/fixture' }]);
    const op = operations[requests - 1];
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1,
      model: 'kimi-for-coding', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const chunks = [chunk({ role: 'assistant' })];
    if (op) chunks.push(chunk({ tool_calls: [{ index: 0, id: `tool-${requests}`, type: 'function', function: { name: op[0], arguments: JSON.stringify(op[1]) } }] }), chunk({}, 'tool_calls'));
    else chunks.push(chunk({ content: role === 'actor' ? 'Completed 中文 🧪.' : '{"safe":true}' }), chunk({}, 'stop'));
    chunks.push('data: [DONE]\n\n');
    return new Response(Readable.from(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const terminal = await runKimiGuest(frame, controller.signal, value => { frames.push(value); onFrame(value); }, loadSDK);
    assert.equal(terminal.kind, expectedTerminal, JSON.stringify(terminal));
    const ledger = new NormalizedEventLedgerV1(frozen.attemptID);
    for (const { event } of frames.filter(frame => frame.kind === 'event')) ledger.observe(event);
    ledger.assertTerminal(terminal);
    assert.equal(frames.filter(frame => frame.kind === 'terminal').length, 1);
    assert.equal(fs.existsSync(path.join(scratchRoot, 'home')), false, 'private config is removed before terminal');
    if (mode !== 'cancel') {
      assert.ok(roundTrip);
      assert.ok(frames.some(frame => frame.event?.kind === 'tool_completed' && frame.event.status === 'completed'));
      if (role === 'actor') assert.equal(fs.readFileSync(path.join(workspaceRoot, 'out/notes.md'), 'utf8'), note);
      if (mode === 'web') {
        assert.deepEqual(webRequests, ['search', 'fetch']);
        assert.equal(frames.filter(frame => frame.event?.kind === 'tool_started' && frame.event.operation === 'web').length, 2);
        assert.equal(frames.some(frame => frame.event?.kind === 'tool_completed' && frame.event.status === 'failed'), false);
      }
    }
    return { frozen, frames, terminal };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// Inject only after the real SDK has finished the fixture's native Read/Write
// round trip. Fetch stays mocked and the socket guard remains active.
async function fixtureWithNativeEvents(end, retryEvents = []) {
  const sdk = await import(pathToFileURL(sdkPath).href);
  const nativeEnds = [];
  const result = await fixture('actor', 'complete', {
    expectedTerminal: end.reason === 'completed' ? 'end_turn' : 'failed',
    loadSDK: async () => ({
      createKimiHarness(options) {
        const harness = sdk.createKimiHarness(options);
        return {
          async createSession(options) {
            const session = await harness.createSession(options);
            const onEvent = session.onEvent.bind(session);
            session.onEvent = handler => onEvent(event => {
              if (event.type !== 'turn.ended') return handler(event);
              nativeEnds.push(event.reason);
              for (const retry of retryEvents) handler({ type: 'turn.step.retrying', ...retry });
              handler({ ...event, ...end });
            });
            return session;
          },
          close: () => harness.close(),
        };
      },
    }),
  });
  assert.deepEqual(nativeEnds, ['completed'], 'injection follows one successful real SDK turn');
  return result;
}

const privateNativeMessage = `ALMA_PRIVATE_NATIVE_ERROR ${PLACEHOLDER_KEY} /private/kimi-error-body.txt`;
function assertNoNativeErrorLeak(frames) {
  const retained = JSON.stringify(frames);
  for (const secret of ['ALMA_PRIVATE_NATIVE_ERROR', PLACEHOLDER_KEY, '/private/kimi-error-body.txt']) {
    assert.equal(retained.includes(secret), false, 'retained events and terminal omit private native errors');
  }
}
async function assertNativeFailure(error, code, family, retryable, extraEnd = {}) {
  const { frames, terminal } = await fixtureWithNativeEvents({ reason: 'failed', error, ...extraEnd });
  assert.deepEqual({ code: terminal.failure.code, family: terminal.failure.family, retryable: terminal.failure.retryable },
    { code, family, retryable });
  assert.equal(frames.some(frame => frame.event?.kind === 'message_started'
    && frame.event.role === 'final_answer'), false, 'native failure suppresses the final answer');
  assertNoNativeErrorLeak(frames);
}

test('original adapter with official SDK 2.4.1 normalizes Actor Read/Write and both Guardians', async () => {
  for (const role of ['actor', 'raw_guardian', 'extra_guardian']) await fixture(role);
});
test('checking an authorized output before creation is a recoverable missing-file result', async () => {
  const result = await fixture('actor', 'read-missing');
  const failed = result.frames.filter(frame => frame.event?.kind === 'tool_completed' && frame.event.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].event.detail, /not found|does not exist|ENOENT/i);
  assert.doesNotMatch(failed[0].event.detail, /permission denied/i);
  assert.equal(result.terminal.kind, 'end_turn');
});
test('missing-path approvals retain workspace, writable-root and link boundaries', async () => {
  const { approveKimiTool, kimiProfile } = load(path.join(root, 'platform/kimi/adopted/policy.ts'));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alma-kimi-paths-')));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, 'out'));
  const profile = kimiProfile(attempt('actor'));
  const approve = (toolName, target) => approveKimiTool({ toolName, toolCallId: 'fixture',
    display: { kind: 'file_io', operation: toolName.toLowerCase(), path: target } }, profile, workspace, ['out']);
  try {
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      assert.equal((await approve(tool, path.join(workspace, 'out/new/missing.md'))).decision, 'approved');
      assert.equal((await approve(tool, path.join(directory, 'outside.md'))).decision, 'rejected');
    }
    assert.equal((await approve('Write', path.join(workspace, 'inbox/new.md'))).decision, 'rejected');
    fs.symlinkSync(directory, path.join(workspace, 'out/link'));
    assert.equal((await approve('Read', path.join(workspace, 'out/link/missing.md'))).decision, 'rejected');
    fs.writeFileSync(path.join(workspace, 'out/original.md'), 'fixture');
    fs.linkSync(path.join(workspace, 'out/original.md'), path.join(workspace, 'out/alias.md'));
    assert.equal((await approve('Read', path.join(workspace, 'out/alias.md'))).decision, 'rejected');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('original adapter retains Web grants and cancels a real SDK request', async () => {
  await fixture('actor', 'web');
  await fixture('actor', 'cancel');
});
test('thinking bursts retain one-second liveness and immediate ordered SDK lifecycles', async t => {
  const sdk = await import(pathToFileURL(sdkPath).href);
  let now = 0, injected = false, nativeSteps = 0, thinkingDeltas = 0;
  const observed = [], heartbeats = [], closes = [];
  t.mock.method(performance, 'now', () => now);
  const result = await fixture('actor', 'complete', {
    onFrame(frame) {
      observed.push(frame);
      if (frame.event?.kind === 'activity' && frame.event.phase === undefined) heartbeats.push(now);
      if ((frame.event?.kind === 'message_started' && frame.event.role === 'final_answer') || frame.kind === 'terminal') {
        assert.deepEqual(closes, ['session', 'harness'], 'final output follows both completed closes');
      }
    },
    loadSDK: async () => ({
      createKimiHarness(options) {
        const harness = sdk.createKimiHarness(options);
        return {
          async createSession(options) {
            const session = await harness.createSession(options);
            const onEvent = session.onEvent.bind(session);
            const close = session.close.bind(session);
            session.close = async () => { await close(); closes.push('session'); };
            session.onEvent = handler => onEvent(event => {
              const before = heartbeats.length;
              handler(event);
              if (event.type === 'turn.step.started') {
                nativeSteps++;
                assert.equal(heartbeats.length, before + 1, 'every real step immediately emits a heartbeat');
                if (!injected) {
                  injected = true;
                  const burst = (at, expected) => {
                    now = at;
                    const previous = heartbeats.length;
                    for (let i = 0; i < 128; i++) {
                      handler({ type: 'thinking.delta', delta: 'private thinking' });
                      thinkingDeltas++;
                    }
                    assert.equal(heartbeats.length - previous, expected, `thinking activity at ${at} ms`);
                  };
                  burst(0, 0);
                  burst(999, 0);
                  burst(1000, 1);
                  burst(1999, 0);
                  burst(2000, 1);
                  now = 2001;
                  handler({ type: 'turn.step.started' });
                  assert.deepEqual(heartbeats, [0, 1000, 2000, 2001], 'step heartbeat bypasses the thinking interval');
                  burst(2001, 0);
                  burst(3000, 0);
                  burst(3001, 1);
                  handler({ type: 'assistant.delta', delta: 'Preparing fixture tools. 中文 🧪' });
                  handler({ type: 'turn.step.retrying', nextAttempt: 1 });
                  handler({ type: 'turn.step.retrying', nextAttempt: 2 });
                }
              }
              if (event.type === 'tool.call.started') {
                for (const percent of [25, 75]) handler({ type: 'tool.progress', toolCallId: event.toolCallId,
                  update: { kind: 'progress', percent, text: 'fixture progress' } });
              }
              if (event.type === 'turn.ended') {
                assert.equal(event.reason, 'completed', 'real SDK turn completes successfully');
              }
            });
            return session;
          },
          async close() { await harness.close(); closes.push('harness'); },
        };
      },
    }),
  });
  assert.equal(thinkingDeltas, 1024, 'every injected native delta reaches the adapter');
  assert.deepEqual(heartbeats.slice(0, 5), [0, 1000, 2000, 2001, 3001]);
  assert.equal(heartbeats.length, nativeSteps + 4, 'only three thinking heartbeats and one injected step are added');
  const events = result.frames.flatMap(frame => frame.event ? [frame.event] : []);
  const retries = events.filter(event => event.kind === 'activity' && event.phase === 'retrying');
  assert.deepEqual(retries.map(event => event.detail), [
    'Kimi is retrying a model request · attempt 1', 'Kimi is retrying a model request · attempt 2',
  ]);
  assert.deepEqual(events.filter(event => event.kind !== 'activity').map(event => event.kind), [
    'message_started', 'message_delta', 'message_completed',
    'tool_started', 'tool_updated', 'tool_updated', 'tool_completed',
    'tool_started', 'tool_updated', 'tool_updated', 'tool_completed',
    'message_started', 'message_delta', 'message_completed',
  ]);
  const commentary = events.find(event => event.kind === 'message_started' && event.role === 'commentary');
  assert.equal(events.find(event => event.kind === 'message_delta' && event.messageID === commentary.messageID).text,
    'Preparing fixture tools. 中文 🧪');
  assert.equal(result.terminal.finalText, 'Completed 中文 🧪.');
  assert.equal(observed.at(-1).kind, 'terminal');
  assertNoNativeErrorLeak(result.frames);
  assert.equal(JSON.stringify(result.frames).includes('private thinking'), false);
});
test('native failure codes classify direct errors and nested causes without leaking raw messages', async t => {
  const cases = [
    ['provider.connection_error', 'kimi_connection_failed', 'provider_availability', true],
    ['loop.max_steps_exceeded', 'kimi_step_limit', 'resource', false],
    ['compaction.failed', 'kimi_compaction_failed', 'provider_availability', true],
    ['compaction.unable', 'kimi_compaction_unable', 'resource', false],
    ['provider.filtered', 'kimi_filtered', 'provider_availability', false],
    ['provider.rate_limit', 'kimi_rate_limited', 'rate_or_quota', true],
    ['provider.overloaded', 'kimi_overloaded', 'provider_availability', true],
    ['auth.token_unauthorized', 'kimi_auth_invalid', 'authentication', false],
    ['context.overflow', 'kimi_context_limit', 'resource', false],
  ];
  for (const [nativeCode, code, family, retryable] of cases) {
    const error = { code: nativeCode, message: privateNativeMessage };
    await t.test(`${nativeCode} directly maps to ${code}`, () => assertNativeFailure(error, code, family, retryable));
    await t.test(`${nativeCode} maps through unknown nested causes`, () => assertNativeFailure({
      code: 'unknown.outer', message: privateNativeMessage,
      cause: { code: 'unknown.inner', message: privateNativeMessage, cause: error },
    }, code, family, retryable));
  }
  await t.test('legacy max_steps interrupt remains a resource failure', () => assertNativeFailure(
    undefined, 'kimi_step_limit', 'resource', false, { reason: 'interrupted', interruptReason: 'max_steps' }));
});
test('native HTTP failures validate status fields and preserve specialized mappings', async t => {
  const cases = [
    [400, 'kimi_http_400', 'provider_availability', false],
    [401, 'kimi_auth_invalid', 'authentication', false],
    [403, 'kimi_model_access_denied', 'configuration', false],
    [404, 'kimi_http_404', 'provider_availability', false],
    [408, 'kimi_http_408', 'provider_availability', true],
    [409, 'kimi_http_409', 'provider_availability', true],
    [429, 'kimi_rate_limited', 'rate_or_quota', true],
    [499, 'kimi_http_499', 'provider_availability', false],
    [500, 'kimi_http_500', 'provider_availability', true],
    [503, 'kimi_http_503', 'provider_availability', true],
    [529, 'kimi_overloaded', 'provider_availability', true],
    [599, 'kimi_http_599', 'provider_availability', true],
  ];
  for (const [status, code, family, retryable] of cases) {
    for (const [field, payload] of [
      ['details.statusCode', { details: { statusCode: status } }],
      ['statusCode', { statusCode: status }],
      ['status', { status }],
    ]) {
      const error = { code: 'provider.api_error', message: privateNativeMessage, ...payload };
      await t.test(`HTTP ${status} from ${field} maps to ${code}`, () => assertNativeFailure(error, code, family, retryable));
    }
    await t.test(`nested HTTP ${status} maps to ${code}`, () => assertNativeFailure({
      message: privateNativeMessage, cause: { details: { statusCode: status }, message: privateNativeMessage },
    }, code, family, retryable));
  }
  for (const status of [399, 600, -1, 500.5, '500', NaN, Infinity, null]) {
    await t.test(`invalid HTTP status ${String(status)} uses the safe fallback`, () => assertNativeFailure(
      { statusCode: status, message: privateNativeMessage }, 'kimi_turn_failed', 'provider_availability', true));
  }
});
test('native cause traversal is bounded and unknown payloads retain only the safe fallback', async t => {
  let error = { code: 'provider.connection_error', message: privateNativeMessage };
  for (let depth = 1; depth < 8; depth++) error = { message: privateNativeMessage, cause: error };
  await t.test('known cause at the eighth node is classified', () => assertNativeFailure(
    error, 'kimi_connection_failed', 'provider_availability', true));
  await t.test('known cause beyond eight nodes is ignored', () => assertNativeFailure(
    { message: privateNativeMessage, cause: error }, 'kimi_turn_failed', 'provider_availability', true));
  const cyclic = { message: privateNativeMessage };
  cyclic.cause = cyclic;
  await t.test('cyclic unknown cause terminates with a safe fallback', () => assertNativeFailure(
    cyclic, 'kimi_turn_failed', 'provider_availability', true));
  for (const [name, payload] of [
    ['absent', undefined],
    ['null', null],
    ['raw string', privateNativeMessage],
    ['unknown code and name', { code: privateNativeMessage, name: privateNativeMessage, message: privateNativeMessage }],
    ['misleading raw message', { message: `${privateNativeMessage} HTTP 429 provider.rate_limit context.overflow` }],
    ['unknown nested message', { cause: { message: privateNativeMessage } }],
  ]) {
    await t.test(`${name} payload omits raw text`, () => assertNativeFailure(
      payload, 'kimi_turn_failed', 'provider_availability', true));
  }
});
test('retrying activity retains only allowlisted names, valid HTTP status and bounded attempt numbers', async () => {
  const names = ['APIConnectionError', 'APITimeoutError', 'APIStatusError', 'APIEmptyResponseError', 'APIOverloadedError'];
  const baseDetail = 'Kimi is retrying a model request';
  const cases = names.map(errorName => ({
    event: { errorName, statusCode: 503, nextAttempt: 2 },
    detail: `${baseDetail} · ${errorName} · HTTP 503 · attempt 2`,
  }));
  cases.push(
    { event: { errorName: 'APIStatusError', statusCode: 400, nextAttempt: 1 },
      detail: `${baseDetail} · APIStatusError · HTTP 400 · attempt 1` },
    { event: { errorName: 'APIStatusError', statusCode: 599, nextAttempt: 100 },
      detail: `${baseDetail} · APIStatusError · HTTP 599 · attempt 100` },
    { event: { errorName: 'UnlistedError' }, detail: baseDetail },
    { event: { errorName: `APIConnectionError ${privateNativeMessage}` }, detail: baseDetail },
    { event: { errorName: null }, detail: baseDetail },
    { event: {}, detail: baseDetail },
  );
  for (const statusCode of [399, 600, 500.5, '503', NaN, Infinity]) {
    cases.push({ event: { statusCode }, detail: baseDetail });
  }
  for (const nextAttempt of [0, -1, 101, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    cases.push({ event: { nextAttempt }, detail: baseDetail });
  }
  const { frames } = await fixtureWithNativeEvents({ reason: 'completed' }, cases.map(({ event }) => ({
    failedAttempt: 1, maxAttempts: 3, delayMs: 987654,
    errorMessage: privateNativeMessage, message: privateNativeMessage,
    error: { message: privateNativeMessage }, ...event,
  })));
  const retained = frames.filter(frame => frame.event?.kind === 'activity' && frame.event.phase === 'retrying');
  assert.deepEqual(retained.map(frame => frame.event.detail), cases.map(entry => entry.detail));
  assertNoNativeErrorLeak(frames);
});
test('guest cleanup independently closes session and harness and outranks completion or cancellation', async () => {
  const sdk = await import(pathToFileURL(sdkPath).href);
  for (const mode of ['complete', 'cancel']) {
    for (const failingClose of ['session', 'harness', 'both']) {
      const closes = [];
      let realHarness;
      try {
        const result = await fixture('actor', mode, { expectedTerminal: 'failed', loadSDK: async () => ({
          createKimiHarness(options) {
            realHarness = sdk.createKimiHarness(options);
            return {
              async createSession(options) {
                const session = await realHarness.createSession(options);
                const closeSession = session.close.bind(session);
                session.close = async () => {
                  closes.push('session:start');
                  await closeSession();
                  closes.push('session:settled');
                  if (failingClose !== 'harness') throw new Error('injected session close failure');
                };
                return session;
              },
              async close() {
                closes.push('harness:start');
                await realHarness.close();
                closes.push('harness:settled');
                if (failingClose !== 'session') throw new Error('injected harness close failure');
              },
            };
          },
        }) });
        assert.deepEqual(closes, ['session:start', 'session:settled', 'harness:start', 'harness:settled']);
        assert.equal(result.terminal.failure.family, 'cleanup');
        assert.equal(result.terminal.failure.code, 'kimi_close_failed');
        assert.equal(result.terminal.failure.retryable, true);
        assert.equal(result.frames.some(frame => frame.event?.kind === 'message_started'
          && frame.event.role === 'final_answer'), false, 'cleanup failure suppresses the final answer');
      } finally {
        if (realHarness && !closes.includes('harness:settled')) await realHarness.close();
      }
    }
  }
});
test('pipe transport ACK, header abort, body destruction and service-only Web policy', async () => {
  const frames = [];
  let transport;
  transport = createPipeFetch(frame => {
    frames.push(frame);
    if (frame.kind === 'http') queueMicrotask(() => {
      transport.receive({ kind: 'headers', id: frame.id, status: 200, headers: {} });
      transport.receive({ kind: 'chunk', id: frame.id, data: Buffer.from('中文 🧪').toString('base64') });
    });
    if (frame.kind === 'httpAck') transport.receive({ kind: 'end', id: frame.id });
  }, false);
  const response = await transport.fetch('https://api.kimi.com/coding/v1/chat/completions', { method: 'POST' });
  assert.equal(await response.text(), '中文 🧪');
  assert.equal(frames.filter(frame => frame.kind === 'httpAck').length, 1);
  assert.equal(frames.filter(frame => frame.kind === 'httpCancel').length, 0);
  assert.equal(transport.pendingRequests, 0);
  await assert.rejects(transport.fetch('https://api.kimi.com/coding/v1/fetch'));
  await assert.rejects(transport.fetch('https://example.com'));
  for (const mode of ['headers', 'body']) {
    const sent = [], controller = new AbortController();
    const pipe = createPipeFetch(frame => sent.push(frame), true);
    const pending = pipe.fetch('https://api.kimi.com/coding/v1/fetch', { signal: controller.signal });
    if (mode === 'headers') { controller.abort(); await assert.rejects(pending); }
    else {
      pipe.receive({ kind: 'headers', id: 1, status: 200, headers: {} });
      const response = await pending;
      response.body.destroy();
      await new Promise(resolve => response.body.once('close', resolve));
    }
    assert.equal(sent.filter(frame => frame.kind === 'httpCancel').length, 1);
    assert.equal(pipe.pendingRequests, 0);
  }
});

test('pipe transport preserves only allowlisted native failure categories', async () => {
  for (const category of ['kimi_http_timeout', 'kimi_response_limit', privateNativeMessage]) {
    for (const body of [false, true]) {
      const transport = createPipeFetch(() => {}, false);
      const pending = transport.fetch('https://api.kimi.com/coding/v1/chat/completions');
      if (body) transport.receive({ kind: 'headers', id: 1, status: 200, headers: {} });
      transport.receive({ kind: 'error', id: 1, message: category });
      const fallback = body ? 'kimi_http_response_failed' : 'kimi_http_headers_unavailable';
      const expected = category === privateNativeMessage ? fallback : category;
      await assert.rejects(body ? (await pending).text() : pending, error => error.message.includes(expected) && !error.message.includes(privateNativeMessage));
      assert.equal(transport.pendingRequests, 0);
    }
  }
});

test('native API errors retain exact transport categories without raw payload text', async () => {
  await assertNativeFailure({ code: 'provider.api_error', message: 'Error: kimi_response_limit' }, 'kimi_response_limit', 'resource', false);
  await assertNativeFailure({ code: 'internal', message: 'Error: kimi_response_limit' }, 'kimi_response_limit', 'resource', false);
  await assertNativeFailure({ code: 'provider.api_error', message: 'Error: kimi_http_timeout' }, 'kimi_http_timeout', 'provider_availability', true);
  await assertNativeFailure({ code: 'provider.api_error', message: privateNativeMessage }, 'kimi_api_error', 'provider_availability', true);
});
test('trusted adapter projects native auth and enforces ledger, cleanup and capture', async () => {
  const recorded = await fixture('actor');
  const handle = randomUUID(), methods = [];
  const receipt = { runtimeClosed: true, requestsJoined: true, scopeQuiescent: true, eventsRetained: true };
  let queue = recorded.frames.filter(frame => frame.kind === 'event').map(frame => frame.event);
  globalThis.__almaPlatformCall = async (method, input) => {
    methods.push(method);
    switch (method) {
      case 'provider.kimi.inspect': return { state: 'valid', credentialHandle: handle, models: { data: [{ id: 'kimi-for-coding' }, { id: 'unknown' }] }, usages: { usages: { limit_5h: { used_ratio: 0.25 } } } };
      case 'provider.kimi.prepare': assert.equal(input.inputFiles[0].base64, Buffer.from(marker).toString('base64')); return { handle, workspaceRoot: '/workspace/test/work', scratchRoot: '/workspace/test/private' };
      case 'provider.kimi.start': case 'provider.kimi.cancel': case 'provider.kimi.release': return {};
      case 'provider.kimi.nextEvent': return queue.length ? { done: false, event: queue.shift() } : { done: true, terminal: recorded.terminal };
      case 'provider.kimi.close': return receipt;
      case 'provider.kimi.capture': return { scopeID: handle, quiescent: true, entries: [{ relativePath: 'out/notes.md', kind: 'file', byteLength: Buffer.byteLength(note), base64: Buffer.from(note).toString('base64') }] };
      default: throw new Error(method);
    }
  };
  const auth = await mobileKimiProvider.authenticate({ providerID: 'kimi', kind: 'authenticate', credential: null,
    signal: new AbortController().signal, challenge: () => { throw Error('native prompt only'); } });
  assert.equal(auth.catalog.models.length, 1);
  assert.equal(auth.accountUsage.buckets[0].remainingPercent, 75);
  const built = { attempt: recorded.frozen, inputBytes: new Map([['input.txt', Buffer.from(marker)]]) };
  const result = await mobileKimiProvider.run(built, Buffer.from(handle), undefined, new AbortController().signal);
  assert.equal(result.candidateFiles.get('out/notes.md').toString(), note);
  assert.deepEqual(methods.slice(-3), ['provider.kimi.close', 'provider.kimi.capture', 'provider.kimi.release']);
  queue = [{ ...recorded.frames.find(frame => frame.kind === 'event').event, sequence: 4 }];
  await assert.rejects(mobileKimiProvider.run(built, Buffer.from(handle), undefined, new AbortController().signal));
  assert.deepEqual(methods.slice(-3), ['provider.kimi.cancel', 'provider.kimi.close', 'provider.kimi.release']);
});

test('trusted adapter rejects unsafe capture and incomplete closure and joins cancellation', async () => {
  const frozen = attempt(), handle = randomUUID(), credential = Buffer.from(handle);
  const built = { attempt: frozen, inputBytes: new Map([['input.txt', Buffer.from(marker)]]) };
  let methods = [], cancelled = false, receipt = { runtimeClosed: true, requestsJoined: true, scopeQuiescent: true, eventsRetained: true };
  let entry = { relativePath: '../private', kind: 'file', byteLength: 1, base64: 'YQ==' };
  let controller = new AbortController();
  globalThis.__almaPlatformCall = async method => {
    methods.push(method);
    switch (method) {
      case 'provider.kimi.prepare': return { handle, workspaceRoot: '/workspace/test/work', scratchRoot: '/workspace/test/private' };
      case 'provider.kimi.start': controller.abort(); return {};
      case 'provider.kimi.cancel': await new Promise(resolve => setTimeout(resolve, 10)); cancelled = true; return {};
      case 'provider.kimi.nextEvent': return { done: true, terminal: { kind: 'cancelled' } };
      case 'provider.kimi.close': assert.ok(cancelled); return receipt;
      case 'provider.kimi.capture': return { scopeID: handle, quiescent: true, entries: [entry] };
      case 'provider.kimi.release': return {};
      default: throw Error(method);
    }
  };
  await assert.rejects(mobileKimiProvider.run(built, credential, undefined, controller.signal), /Invalid candidate path/);
  assert.equal(methods.at(-1), 'provider.kimi.release');
  methods = []; cancelled = false; controller = new AbortController(); receipt = { ...receipt, requestsJoined: false };
  await assert.rejects(mobileKimiProvider.run(built, credential, undefined, controller.signal), error => error.code === 'cleanup');
  assert.equal(methods.includes('provider.kimi.capture'), false);
  assert.equal(methods.at(-1), 'provider.kimi.release');
  methods = []; controller = new AbortController();
  const wrong = { ...built, inputBytes: new Map([['input.txt', Buffer.from('tampered')]]) };
  await assert.rejects(mobileKimiProvider.run(wrong, credential, undefined, controller.signal), /Frozen input identity mismatch/);
  assert.deepEqual(methods, []);
});

test('native invalid credentials and unavailable catalogs preserve Mac auth semantics', async () => {
  const context = { providerID: 'kimi', kind: 'inspect', credential: Buffer.from(randomUUID()), signal: new AbortController().signal,
    challenge: () => { throw Error('native prompt only'); } };
  globalThis.__almaPlatformCall = async () => ({ state: 'invalid', credentialHandle: null, models: null, usages: null });
  assert.deepEqual(await mobileKimiProvider.authenticate(context), { state: 'invalid', credential: null, account: null,
    catalog: null, catalogUnavailable: false, accountUsage: null, accountUsageUnavailable: false });
  globalThis.__almaPlatformCall = async () => ({ state: 'valid', credentialHandle: randomUUID(), models: { data: [{ id: 'unknown' }] }, usages: null });
  const result = await mobileKimiProvider.authenticate(context);
  assert.equal(result.state, 'valid'); assert.equal(result.catalogUnavailable, true); assert.equal(result.accountUsageUnavailable, true);
});

function authorizedService(provider) {
  const record = { version: 1, providerID: provider.id, state: 'valid',
    credential: Buffer.from(randomUUID()).toString('base64'), account: 'Fixture account', checkedAt: '2026-11-03T00:00:00.000Z' };
  const mutations = [];
  const auth = new AuthService({
    async load() { return structuredClone(record); },
    async save(value) { mutations.push({ kind: 'save', value }); },
    async reset(providerID) { mutations.push({ kind: 'reset', providerID }); },
    async close() {},
  }, context => provider.authenticate(context));
  return { auth, record, mutations };
}

test('both providers retain valid authorization after native inspection outages and timeouts', async () => {
  for (const provider of [mobileKimiProvider, mobileCodexProvider]) {
    for (const code of ['provider_unavailable', 'unavailable', 'provider_timeout', 'timeout', undefined]) {
      const { auth, record, mutations } = authorizedService(provider);
      globalThis.__almaPlatformCall = async method => {
        assert.equal(method, `provider.${provider.id}.inspect`);
        throw Object.assign(new Error('fixture transport failure'), { code });
      };
      await auth.initialize();
      const snapshot = await auth.inspectAndWait();
      assert.equal(snapshot.state, 'valid', `${provider.id}/${code}`);
      assert.equal(snapshot.account, record.account);
      assert.equal(snapshot.noticeCode, 'inspection_unavailable_retained');
      assert.deepEqual(snapshot.inspection.failures, [code?.includes('timeout') ? 'timeout' : 'unavailable']);
      assert.deepEqual(mutations, [], 'transient inspection must not save or reset credentials');
      await auth.withCredential(provider.id, async credential => {
        assert.equal(credential.toString('base64'), record.credential);
      });
      await auth.close();
    }
  }
});

test('explicit native inspection cleanup remains fatal for both providers, including an aborted signal', async () => {
  for (const provider of [mobileKimiProvider, mobileCodexProvider]) {
    for (const code of ['provider_cleanup', 'cleanup']) {
      const controller = new AbortController();
      globalThis.__almaPlatformCall = async () => {
        controller.abort();
        throw Object.assign(new Error('fixture cleanup failure'), { code });
      };
      await assert.rejects(provider.authenticate({ providerID: provider.id, kind: 'inspect',
        credential: Buffer.from(randomUUID()), signal: controller.signal }),
      error => error instanceof AuthOperationError && error.code === 'cleanup');

      const { auth, mutations } = authorizedService(provider);
      await auth.initialize();
      const snapshot = await auth.inspectAndWait();
      assert.equal(snapshot.phase, 'fatal');
      assert.equal(snapshot.state, 'unauthed');
      assert.deepEqual(snapshot.inspection.failures, ['cleanup']);
      assert.deepEqual(mutations, [{ kind: 'reset', providerID: provider.id }]);
      await auth.close();
    }
  }
});

test('Codex inspection validates closure before applying cancellation', async () => {
  const controller = new AbortController();
  globalThis.__almaPlatformCall = async () => {
    controller.abort();
    return { closed: { kind: 'in_process', runtimeClosed: false } };
  };
  await assert.rejects(mobileCodexProvider.authenticate({ providerID: 'codex', kind: 'inspect',
    credential: Buffer.from(randomUUID()), signal: controller.signal }),
  error => error instanceof AuthOperationError && error.code === 'cleanup');
});

test('close and release rejection reaches Core as cleanup uncertainty even during cancellation', async () => {
  for (const provider of [mobileKimiProvider, mobileCodexProvider]) {
    const operations = provider.id === 'codex' ? ['close', 'authRelease', 'release'] : ['close', 'release'];
    const codes = ['provider_cleanup', 'provider_unavailable', 'provider_timeout', 'unavailable', undefined];
    const failures = operations.flatMap(failedOperation =>
      codes.map(code => ({ failedOperation, code })));
    for (const { failedOperation, code } of failures) {
      for (const abort of [false, true]) {
        const frozen = attempt();
        frozen.providerID = provider.id;
        if (provider.id === 'codex') frozen.inference.modelID = 'gpt-5.6-luna';
        const built = { attempt: frozen, inputBytes: new Map([['input.txt', Buffer.from(marker)]]) };
        const handle = randomUUID(), methods = [], controller = new AbortController();
        const { auth } = authorizedService(provider);
        await auth.initialize();
        globalThis.__almaPlatformCall = async method => {
          const operation = method.split('.').at(-1);
          methods.push(operation);
          if (operation === failedOperation) throw Object.assign(new Error('native transport failure'), { code });
          switch (operation) {
            case 'prepare': return { handle, workspaceRoot: '/workspace/test/work', scratchRoot: '/workspace/test/private',
              ...(provider.id === 'codex' ? { controllerHome: '/controller/test' } : {}) };
            case 'start':
              if (provider.id === 'kimi' && abort) controller.abort();
              return null;
            case 'request':
              // Exercise the real Codex guest's error/cancellation cleanup path.
              if (abort) controller.abort();
              throw new Error('fixture initialize failed');
            case 'nextEvent': return { done: true, terminal: { kind: 'cancelled' } };
            case 'close': return { kind: 'in_process', runtimeClosed: true, requestsJoined: true,
              eventsRetained: true, scopeQuiescent: true };
            case 'capture': return { scopeID: handle, quiescent: true, entries: [] };
            case 'authBind': case 'authRelease': case 'cancel': case 'release': return null;
            default: throw new Error(method);
          }
        };
        const scheduler = new BoundedTahHostOperationSchedulerV1();
        const port = mobileAttemptPort(auth, scheduler, [{ id: provider.id, disabledModels: [] }], new Map([[provider.id, provider]]));
        await assert.rejects(port.run(built, undefined, controller.signal),
          error => error instanceof TahAttemptExecutionErrorV1 && error.category === 'cleanup_unconfirmed',
          `${provider.id}/${failedOperation}/${code}/abort=${abort}`);
        assert.ok(methods.includes(failedOperation), 'the intended failing operation was reached');
        assert.equal(methods.at(-1), 'release', 'release is attempted after earlier cleanup failures');
        assert.throws(() => auth.withCredential(provider.id, async () => {}),
          'cleanup uncertainty blocks another credential borrower');
        await assert.rejects(auth.close(), error => error instanceof AuthOperationError && error.code === 'cleanup');
        await scheduler.close();
      }
    }
  }
});

test('Kimi cleanup terminal and finalization failures outrank incomplete events and observer errors', async () => {
  for (const mode of ['terminal', 'close', 'release']) {
    const frozen = attempt(), handle = randomUUID(), methods = [];
    const built = { attempt: frozen, inputBytes: new Map([['input.txt', Buffer.from(marker)]]) };
    const events = [{ attemptID: frozen.attemptID, sequence: 1, kind: 'tool_started',
      toolCallID: 'unfinished-tool', operation: 'text_read', detail: 'Reading input' }];
    globalThis.__almaPlatformCall = async method => {
      const operation = method.split('.').at(-1);
      methods.push(operation);
      if (operation === mode) throw new Error('native generic failure');
      switch (operation) {
        case 'prepare': return { handle, workspaceRoot: '/workspace/test/work', scratchRoot: '/workspace/test/private' };
        case 'nextEvent': return events.length ? { done: false, event: events.shift() } : {
          done: true, terminal: { kind: 'failed', failure: { family: 'cleanup', code: 'kimi_cleanup_incomplete',
            message: 'Fixture cleanup failed', retryable: true } },
        };
        case 'close': return { runtimeClosed: true, requestsJoined: true, eventsRetained: true, scopeQuiescent: true };
        case 'start': case 'cancel': case 'release': return null;
        default: throw new Error(method);
      }
    };
    const onEvent = mode === 'terminal' ? undefined : () => { throw new Error('fixture observer failed'); };
    await assert.rejects(mobileKimiProvider.run(built, Buffer.from(handle), onEvent, new AbortController().signal),
      error => error instanceof AuthOperationError && error.code === 'cleanup');
    assert.equal(methods.at(-1), 'release');
    assert.equal(methods.includes('capture'), false);
  }
});
