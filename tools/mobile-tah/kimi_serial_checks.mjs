import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// The same TS loader and real bundled SDK used by kimi_checks.mjs.
const root = fileURLToPath(new URL('../../shared/tah-runtime/', import.meta.url));
const probe = fileURLToPath(new URL('../kimi-mobile-probe/', import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const cache = new Map();
function load(id) {
  if (id.startsWith('node:')) return nativeRequire(id);
  if (id === 'zod') return nativeRequire(path.join(root, 'vendor/zod/index.cjs'));
  if (cache.has(id)) return cache.get(id).exports;
  const module = { exports: {} };
  cache.set(id, module);
  const code = ts.transpileModule(fs.readFileSync(id, 'utf8'), {
    fileName: id,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, spec => load(spec.startsWith('.')
    ? path.resolve(path.dirname(id), spec).replace(/\.js$/, '.ts') : spec));
  return module.exports;
}
const { parseStart, runKimiGuest, PLACEHOLDER_KEY } = load(path.join(root, 'platform/kimi/guest/runner.ts'));
const { TAH_ACTOR_ABILITIES } = load(path.join(root, 'upstream/src/contract/abilities.ts'));
const { NormalizedEventLedgerV1 } = load(path.join(root, 'upstream/src/contract/events.ts'));
const { KIMI_OPERATIONS } = load(path.join(root, 'platform/kimi/adopted/policy.ts'));
// Point at the preserved artifact to reproduce the pre-fix failure after promotion.
const sdkPath = path.resolve(process.env.ALMA_KIMI_TEST_SDK_PATH
  ?? path.join(probe, '.cache/latest-release/artifact/opt/kimi/sdk/index.mjs'));
const sdkSHA256 = createHash('sha256').update(fs.readFileSync(sdkPath)).digest('hex');
const fetchPath = path.join(probe, '.cache/latest-release/source/node_modules/.pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js');
const bindings = await import(pathToFileURL(fetchPath).href);
const marker = 'ALMA_SERIAL_FIXTURE Alice Friday 中文 🧪';
const originalNote = '# Notes\nStatus pending\n';
const editedNote = '# Notes\nStatus complete 中文 🧪\n';
const finalText = 'All serial fixture tools finished.';
const baseURL = 'https://api.kimi.com/coding/v1';

function operation(id, name, args) { return { id, name, args }; }

function batchesFor(workspace, cancel) {
  const searches = Array.from({ length: 6 }, (_, i) => operation(`search-${i}`, 'WebSearch', { query: `serial query ${i}` }));
  if (cancel) return [[
    operation('blocking-search', 'WebSearch', { query: 'block until cancelled' }),
    operation('queued-read', 'Read', { path: `${workspace}/input.txt` }),
    operation('queued-glob', 'Glob', { path: workspace, pattern: '*.txt' }),
    operation('queued-grep', 'Grep', { path: `${workspace}/input.txt`, pattern: 'ALMA_SERIAL_FIXTURE' }),
    ...searches,
    operation('queued-fetch', 'FetchURL', { url: 'https://example.test/queued' }),
    operation('queued-write', 'Write', { path: `${workspace}/out/queued.md`, content: 'must never be written' }),
  ]];
  // Edit requires a prior Read. Keep that dependency in earlier model steps.
  return [
    [operation('seed-write', 'Write', { path: `${workspace}/out/notes.md`, content: originalNote })],
    [operation('seed-read', 'Read', { path: `${workspace}/out/notes.md` })],
    [
      operation('mixed-search', 'WebSearch', { query: 'mixed fixture facts' }),
      operation('mixed-read', 'Read', { path: `${workspace}/input.txt` }),
      operation('mixed-glob', 'Glob', { path: workspace, pattern: '*.txt' }),
      operation('mixed-grep', 'Grep', { path: `${workspace}/input.txt`, pattern: 'ALMA_SERIAL_FIXTURE', output_mode: 'content' }),
      operation('mixed-write', 'Write', { path: `${workspace}/out/copy.md`, content: marker }),
      operation('mixed-edit', 'Edit', { path: `${workspace}/out/notes.md`, old_string: 'Status pending', new_string: 'Status complete 中文 🧪' }),
      operation('mixed-fetch', 'FetchURL', { url: 'https://example.test/fixture' }),
      ...searches,
    ],
    [operation('edited-read', 'Read', { path: `${workspace}/out/notes.md` })],
  ];
}

function streamedResponse(batch, step) {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: `serial-step-${step}`, object: 'chat.completion.chunk', created: 1, model: 'kimi-for-coding',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  const chunks = [chunk({ role: 'assistant' })];
  if (batch) {
    chunks.push(chunk({ tool_calls: batch.map((call, index) => ({
      index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) }), chunk({}, 'tool_calls'));
  } else chunks.push(chunk({ content: finalText }), chunk({}, 'stop'));
  chunks.push('data: [DONE]\n\n');
  return new bindings.Response(Readable.from(chunks), { headers: { 'content-type': 'text/event-stream' } });
}

function lifecycle(frames) {
  const active = new Set();
  const starts = [], completions = [], order = [];
  let maximum = 0;
  for (const { event } of frames) {
    if (event?.kind === 'tool_started') {
      assert.ok(!active.has(event.toolCallID), 'each tool starts once');
      active.add(event.toolCallID);
      starts.push(event);
      order.push(`start:${event.toolCallID}`);
      maximum = Math.max(maximum, active.size);
    } else if (event?.kind === 'tool_completed') {
      assert.ok(active.delete(event.toolCallID), 'completion has an active start');
      completions.push(event);
      order.push(`complete:${event.toolCallID}`);
    }
  }
  assert.equal(active.size, 0, 'all normalized tool lifecycles settle before terminal');
  return { maximum, starts, completions, order };
}

async function instrumentOfficialTools(harness, session, calls, executions) {
  // Version-pinned SDK internals provide the actual registered native tools.
  // Wrap their execute functions only to observe entry/settlement. The SDK's
  // executor, scheduler, approvals, and each native implementation still run.
  const rpc = harness.rpc;
  const agent = await rpc.materializeMainAgent(rpc.requireLiveSession(session.id));
  const serviceToken = (container, name) => {
    const token = [...container._services._entries.keys()].find(id => String(id) === name);
    assert.ok(token, `official SDK service is available: ${name}`);
    return token;
  };
  const container = agent.accessor.get(serviceToken(rpc.app.instantiation, 'instantiationService'));
  const registry = agent.accessor.get(serviceToken(container, 'agentToolRegistryService'));
  for (const name of new Set(calls.map(call => call.name))) {
    const tool = registry.resolve(name);
    assert.ok(tool, `official native tool is registered: ${name}`);
    const resolveExecution = tool.resolveExecution;
    tool.resolveExecution = async function (...args) {
      executions.resolved.push(name);
      const execution = await resolveExecution.apply(this, args);
      if (typeof execution.execute !== 'function') return execution;
      const execute = execution.execute;
      return { ...execution, async execute(context) {
        executions.starts.push(context.toolCallId);
        executions.maximum = Math.max(executions.maximum, ++executions.active);
        try { return await execute.call(execution, context); }
        finally {
          --executions.active;
          executions.settled.push(context.toolCallId);
        }
      } };
    };
  }
}

async function fixture(t, { serial = true, cancel = false } = {}) {
  const cacheRoot = fileURLToPath(new URL('.cache/', import.meta.url));
  fs.mkdirSync(cacheRoot, { recursive: true });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(cacheRoot, 'kimi-serial-')));
  const workspaceRoot = path.join(directory, 'workspace');
  const scratchRoot = path.join(directory, 'scratch');
  fs.mkdirSync(path.join(workspaceRoot, 'out'), { recursive: true });
  fs.mkdirSync(scratchRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'input.txt'), marker);
  const attempt = {
    contractVersion: 1, attemptID: randomUUID(), providerID: 'kimi', role: 'actor',
    inference: { modelID: 'kimi-for-coding', reasoningEffortID: 'low' },
    prompt: [{ authority: 'tah_instruction', text: 'Execute the requested fixture tools.' }],
    workspace: {
      materials: [{ relativePath: 'input.txt', mediaType: 'text/plain', byteLength: Buffer.byteLength(marker), sha256: createHash('sha256').update(marker).digest('hex') }],
      candidateSeeds: [], writableRoots: ['out'],
    },
    responseExpectation: { kind: 'workspace_outcome', contractID: 'serial-fixture/v1', maximumFinalMessageUTF8Bytes: 4096 },
    requiredAbilities: [...TAH_ACTOR_ABILITIES, 'web'],
  };
  const batches = batchesFor(workspaceRoot, cancel);
  const frames = [], nativeEvents = [], modelRequests = [], webStarts = [], webSettled = [];
  const executions = { active: 0, maximum: 0, resolved: [], starts: [], settled: [] };
  const controller = new AbortController();
  const previousFlag = process.env.ALMA_KIMI_SERIAL_TOOLS;
  const savedGlobals = new Map(['fetch', 'Headers', 'Request', 'Response', 'FormData'].map(name => [name, globalThis[name]]));
  const savedNet = [net.connect, net.createConnection, net.Socket.prototype.connect];
  const unexpected = [];
  let activeWeb = 0, maximumWeb = 0, abortTimer, deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error('fixture deadline exceeded'));
  }, 15_000);
  const denyNetwork = () => {
    unexpected.push('socket');
    throw new Error('Unexpected fixture network');
  };
  process.env.ALMA_KIMI_SERIAL_TOOLS = serial ? '1' : '0';
  for (const name of ['Headers', 'Request', 'Response', 'FormData']) globalThis[name] = bindings[name];
  net.connect = net.createConnection = net.Socket.prototype.connect = denyNetwork;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    const body = JSON.parse(init.body);
    if (address === `${baseURL}/chat/completions`) {
      assert.equal(new bindings.Headers(init.headers).get('authorization'), `Bearer ${PLACEHOLDER_KEY}`);
      assert.equal(body.model, 'kimi-for-coding');
      modelRequests.push(body);
      assert.ok(modelRequests.length <= batches.length + 1, 'fixture has no unexpected model retries');
      return streamedResponse(batches[modelRequests.length - 1], modelRequests.length);
    }
    if (address !== `${baseURL}/search` && address !== `${baseURL}/fetch`) {
      unexpected.push(address);
      throw new Error(`Unexpected fixture URL ${address}`);
    }
    const key = body.text_query ?? body.url;
    webStarts.push(key);
    maximumWeb = Math.max(maximumWeb, ++activeWeb);
    if (cancel && key === 'block until cancelled') {
      // Allow the batch to queue behind an in-flight resource operation before aborting.
      abortTimer = setTimeout(() => controller.abort(), 50);
    }
    try {
      await delay(cancel ? 10_000 : 30, undefined, { signal: init.signal });
      if (address.endsWith('/search')) return new bindings.Response(JSON.stringify({ search_results: [{
        title: key, url: 'https://example.test/result', snippet: `RESULT ${key}`,
      }] }));
      return new bindings.Response(`FETCHED ${body.url}`);
    } finally {
      --activeWeb;
      webSettled.push(key);
    }
  };
  try {
    const sdk = await import(pathToFileURL(sdkPath).href);
    const terminal = await runKimiGuest(parseStart({ kind: 'start', attempt, workspaceRoot, scratchRoot }),
      controller.signal, frame => frames.push(frame), async () => ({
        createKimiHarness(options) {
          const realOfficialHarness = sdk.createKimiHarness(options);
          return {
            async createSession(options) {
              const session = await realOfficialHarness.createSession(options);
              session.onEvent(event => nativeEvents.push(event));
              const reloadSession = session.reloadSession.bind(session);
              session.reloadSession = async (...args) => {
                const state = await reloadSession(...args);
                await instrumentOfficialTools(realOfficialHarness, session, batches.flat(), executions);
                return state;
              };
              return session;
            },
            close: () => realOfficialHarness.close(),
          };
        },
      }));
    const ledger = new NormalizedEventLedgerV1(attempt.attemptID);
    for (const frame of frames) if (frame.kind === 'event') ledger.observe(frame.event);
    ledger.assertTerminal(terminal);
    assert.deepEqual(frames.filter(frame => frame.kind === 'terminal'), [{ kind: 'terminal', terminal }]);
    assert.equal(frames.at(-1).kind, 'terminal');
    assert.equal(terminal.kind, cancel ? 'cancelled' : 'end_turn', JSON.stringify(terminal));
    assert.equal(deadlineExceeded, false, 'fixture finishes without its watchdog abort');
    assert.equal(fs.existsSync(path.join(scratchRoot, 'home')), false, 'private runtime is closed and removed');
    assert.equal(activeWeb, 0, 'in-flight resource requests are joined before terminal');
    assert.equal(executions.active, 0, 'all actual native executions settle before terminal');
    assert.deepEqual(unexpected, [], 'all HTTP is synthetic and external sockets are forbidden');
    const events = lifecycle(frames);
    t.diagnostic(JSON.stringify({ serial, cancel, sdkSHA256,
      lifecycleMaximum: events.maximum, actualExecutionMaximum: executions.maximum, actualWebMaximum: maximumWeb, requested: batches.flat().length,
      started: events.starts.length, completed: events.completions.length, webStarts }));
    return { terminal, frames, nativeEvents, modelRequests, batches, events, executions, maximumWeb, webStarts, webSettled,
      notes: fs.existsSync(`${workspaceRoot}/out/notes.md`) ? fs.readFileSync(`${workspaceRoot}/out/notes.md`, 'utf8') : null,
      copy: fs.existsSync(`${workspaceRoot}/out/copy.md`) ? fs.readFileSync(`${workspaceRoot}/out/copy.md`, 'utf8') : null,
      queuedWriteExists: fs.existsSync(`${workspaceRoot}/out/queued.md`),
      input: fs.readFileSync(`${workspaceRoot}/input.txt`, 'utf8') };
  } finally {
    clearTimeout(deadline);
    clearTimeout(abortTimer);
    if (previousFlag === undefined) delete process.env.ALMA_KIMI_SERIAL_TOOLS;
    else process.env.ALMA_KIMI_SERIAL_TOOLS = previousFlag;
    for (const [name, value] of savedGlobals) globalThis[name] = value;
    [net.connect, net.createConnection, net.Socket.prototype.connect] = savedNet;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('mobile flag serializes mixed official tools and six searches through completion', { timeout: 20_000 }, async t => {
  const result = await fixture(t);
  const calls = result.batches.flat();
  const nativeResults = result.nativeEvents.filter(event => event.type === 'tool.result');
  assert.equal(nativeResults.length, calls.length, 'every requested call produces a native result');
  assert.deepEqual(nativeResults.filter(event => event.isError), [], 'all real tools succeed');
  assert.equal(result.modelRequests.length, result.batches.length + 1);
  for (let step = 1; step < result.modelRequests.length; ++step) {
    const returned = result.modelRequests[step].messages.filter(message => message.role === 'tool');
    assert.deepEqual(returned.map(message => message.tool_call_id), result.batches.slice(0, step).flat().map(call => call.id),
      'all call results reach the next model request in model order');
  }
  const returned = result.modelRequests.at(-1).messages.filter(message => message.role === 'tool');
  const output = id => JSON.stringify(returned.find(message => message.tool_call_id === id)?.content);
  assert.ok(output('mixed-read').includes(marker));
  assert.ok(output('mixed-glob').includes('input.txt'));
  assert.ok(output('mixed-grep').includes(marker));
  assert.ok(output('edited-read').includes('Status complete 中文 🧪'));
  assert.ok(output('mixed-fetch').includes('FETCHED https://example.test/fixture'));
  for (let i = 0; i < 6; ++i) assert.ok(output(`search-${i}`).includes(`RESULT serial query ${i}`));
  assert.equal(result.notes, editedNote);
  assert.equal(result.copy, marker);
  assert.equal(result.input, marker);
  assert.equal(result.terminal.finalText, finalText);
  assert.equal(result.events.starts.length, calls.length);
  assert.deepEqual(result.events.starts.map(event => event.operation), calls.map(call => KIMI_OPERATIONS[call.name]), 'normalized operations follow the requested call order');
  assert.ok(result.events.completions.every(event => event.status === 'completed'));
  assert.deepEqual(result.executions.starts.slice().sort(), calls.map(call => call.id).sort(), 'every call executes the actual official native implementation');
  assert.equal(result.executions.maximum, 1, 'actual native tool executions must never overlap');
  assert.deepEqual(nativeResults.map(event => event.toolCallId), calls.map(call => call.id), 'native results finalize in model order');
  assert.deepEqual(result.executions.starts, calls.map(call => call.id), 'actual tools execute in model order');
  assert.deepEqual(result.executions.settled, result.executions.starts, 'each actual tool finishes before the next starts');
  assert.equal(result.maximumWeb, 1, 'actual WebSearch/FetchURL resource work must never overlap');
  assert.equal(result.events.maximum, 1, 'normalized started→completed tool lifecycles must never overlap');
  assert.deepEqual(result.events.order, result.events.starts.flatMap(event => [`start:${event.toolCallID}`, `complete:${event.toolCallID}`]));
  assert.deepEqual(result.webSettled, result.webStarts, 'resources complete in invocation order');
});

test('cancellation settles queued official calls without starting resource work', { timeout: 20_000 }, async t => {
  const result = await fixture(t, { cancel: true });
  const calls = result.batches.flat();
  const nativeResults = result.nativeEvents.filter(event => event.type === 'tool.result');
  assert.deepEqual(nativeResults.map(event => event.toolCallId).sort(), calls.map(call => call.id).sort(), 'queued calls receive terminal native results');
  assert.deepEqual(result.executions.starts, ['blocking-search'], 'queued tools never enter actual execution after cancellation');
  assert.deepEqual(result.executions.resolved, ['WebSearch'], 'cancelled queued calls never resolve native resource access');
  assert.deepEqual(result.executions.settled, ['blocking-search']);
  assert.ok(nativeResults.every(event => event.isError), 'cancelled calls settle as errors');
  assert.equal(result.events.starts.length, calls.length);
  assert.ok(result.events.completions.every(event => event.status === 'failed'));
  assert.equal(result.modelRequests.length, 1, 'cancellation ends the model loop');
  assert.deepEqual(result.webStarts, ['block until cancelled'], 'queued WebSearch and FetchURL calls must not acquire resources');
  assert.equal(result.queuedWriteExists, false, 'queued Write must not touch the filesystem');
  assert.equal(result.maximumWeb, 1);
  assert.equal(result.events.maximum, 1);
});

test('flag-off official control exposes overlapping tool work', { timeout: 20_000 }, async t => {
  const result = await fixture(t, { serial: false });
  assert.ok(result.executions.maximum > 1, 'fixture detects overlapping actual native executions');
  assert.ok(result.maximumWeb > 1, 'fixture detects real parallel resource work');
  assert.ok(result.events.maximum > 1, 'fixture detects overlapping normalized lifecycles');
});
