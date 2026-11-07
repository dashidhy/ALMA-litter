// Real, pinned Kimi Harness; synthetic in-memory model transport. No account.
import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import net from 'node:net';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const fetchBindings = process.env.ALMA_KIMI_FETCH_BINDINGS === 'node-fetch';
if (fetchBindings) {
  // Node 22.23.4 exposes lazy WebSocket exports from node:http. ESM import
  // enumerates these and loads Undici even when no request is made. The text
  // fixture does not grant WebSocket; fail explicitly if it is requested.
  const http = createRequire(import.meta.url)('node:http');
  for (const name of ['WebSocket', 'CloseEvent', 'MessageEvent']) {
    Object.defineProperty(http, name, { value: class {
      constructor() { throw Error('probe_websocket_unsupported'); }
    }, configurable: true, enumerable: true });
  }
  // Node's lazily linked web globals can otherwise load built-in Undici while
  // a standards-compatible replacement is itself being imported.
  for (const name of ['Headers', 'Request', 'Response', 'FormData', 'WebSocket', 'EventSource']) {
    delete globalThis[name];
    Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true });
  }
  const bindings = await import('/probe/runtime/node_modules/node-fetch/src/index.js');
  for (const name of ['Headers', 'Request', 'Response', 'FormData']) {
    Object.defineProperty(globalThis, name, { value: bindings[name], writable: true, configurable: true });
  }
}

const mode = process.argv[2];
if (!['import', 'session', 'fixture', 'cancel', 'live'].includes(mode)) throw Error('Unknown probe mode');
const live = mode === 'live';
const output = text => writeSync(1, text);
const started = performance.now();
const events = [];
function emit(type, data = {}) {
  output(JSON.stringify({ type, elapsedMs: Math.round(performance.now() - started), ...data }) + '\n');
}
const networkAttempts = [];
function denySocket() {
  networkAttempts.push('socket');
  throw Error('probe_direct_network_denied');
}
net.connect = denySocket;
net.createConnection = denySocket;
net.Socket.prototype.connect = denySocket;
const root = '/probe-work';
const home = root + '/home';
const workspace = root + '/workspace';
const transcript = 'ALMA_FIXTURE_7B42: Alice delivers Friday; Bob reviews Thursday; budget 500 dollars.';
const expected = '# Fixture notes\nAlice: Friday. Bob: Thursday. Budget: 500 dollars. 中文 😀\n';
let requests = 0;
let readContentRoundTrip = false;
const toolResults = [];
const toolNames = new Map();
let harness, session;
const phases = {};
async function phase(name, run) {
  emit('phase_start', { name });
  const begin = performance.now(), cpu = process.cpuUsage();
  try { return await run(); }
  finally {
    const cost = process.cpuUsage(cpu);
    phases[name] = { elapsedMs: performance.now() - begin, cpuUserMs: cost.user / 1000,
      cpuSystemMs: cost.system / 1000, memory: process.memoryUsage() };
    emit('phase_end', { name, ...phases[name] });
  }
}

// Replaces only transport. The SDK parses streamed model responses and runs its
// own Agent Loop, tools, approval hooks, persistence and terminal events.
globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url !== 'https://fixture.invalid/v1/chat/completions') {
    networkAttempts.push(url);
    throw Error('probe_unexpected_fetch:' + url);
  }
  const body = JSON.parse(init.body);
  if (!Array.isArray(body.messages)) throw Error('fixture_missing_messages');
  requests++;
  emit('fixture_request', { number: requests });
  if (mode === 'fixture' && requests === 2) {
    readContentRoundTrip = body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(transcript));
    if (!readContentRoundTrip) throw Error('real_read_content_missing_from_next_request');
  }
  if (mode === 'cancel') {
    return await new Promise((resolve, reject) => {
      const cancel = () => reject(new DOMException('Fixture aborted', 'AbortError'));
      if (init.signal?.aborted) cancel();
      else init.signal?.addEventListener('abort', cancel, { once: true });
      setTimeout(() => { void session.cancel(); }, 100);
    });
  }
  const steps = [
    ['Read', { path: workspace + '/transcript.txt' }],
    ['Write', { path: workspace + '/notes.md', content: expected }],
  ];
  const operation = steps[requests - 1];
  const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({
    id: 'fixture-' + requests, object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n';
  const chunks = [chunk({ role: 'assistant' })];
  if (operation) chunks.push(chunk({ tool_calls: [{ index: 0, id: 'tool-' + requests,
    type: 'function', function: { name: operation[0], arguments: JSON.stringify(operation[1]) } }] }), chunk({}, 'tool_calls'));
  else chunks.push(chunk({ content: 'Fixture complete.' }), chunk({}, 'stop'));
  chunks.push('data: [DONE]\n\n');
  const iterable = async function* () {
    for (const chunk of chunks) {
      await new Promise(resolve => setTimeout(resolve, 5));
      yield new TextEncoder().encode(chunk);
    }
  };
  const stream = fetchBindings ? Readable.from(iterable()) : ReadableStream.from(iterable());
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

let closeTransport;
if (live) {
  const { installPipeFetch } = await import('./pipe-fetch.mjs');
  closeTransport = installPipeFetch((url, init) => {
    if (!url.includes('/chat/completions') && !url.endsWith('/messages')) return;
    requests++;
    const body = JSON.parse(init.body);
    readContentRoundTrip ||= (body.messages ?? []).some(message => {
      const toolMessage = message.role === 'tool' || Array.isArray(message.content) && message.content.some(part => part.type === 'tool_result');
      return toolMessage && JSON.stringify(message.content).includes('ALMA_FIXTURE_7B42');
    });
  });
}

emit('identity', { mode, platform: process.platform, arch: process.arch, node: process.version,
  execArgv: process.execArgv, webAssembly: typeof WebAssembly, fetchBindings: fetchBindings ? 'node-fetch 3.3.2' : 'Node builtin', transport: live ? 'native-host HTTPS through pipes' : 'in-memory fixture' });
let success = false;
const deadline = setTimeout(() => { emit('failure', { message: 'guest_deadline' }); process.exit(124); }, 150000);
try {
  await fs.mkdir(home + '/empty-skills', { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(workspace + '/transcript.txt', transcript);
  const config = `default_model = "fixture"
default_permission_mode = "manual"
telemetry = false
auto_session_title = false
builtin_product_skills = false
merge_all_available_skills = false
hooks = []
[watch]
enabled = false
[tools]
enabled = ["Read", "Write"]
[background]
keep_alive_on_exit = false
[providers.fixture]
type = "${live ? 'kimi' : 'openai'}"
base_url = "${live ? 'https://api.kimi.com/coding/v1' : 'https://fixture.invalid/v1'}"
api_key = "alma-native-credential-handle"
[models.fixture]
provider = "fixture"
model = "${live ? 'kimi-for-coding' : 'fixture'}"
max_context_size = 32768
capabilities = ["tool_use"]
support_efforts = ["low", "high", "max"]
[thinking]
enabled = true
effort = "low"
[loop_control]
max_steps_per_turn = 4
max_attempts_per_step = 1
reserved_context_size = 1024
[[permission.rules]]
decision = "ask"
pattern = "Read"
[[permission.rules]]
decision = "ask"
pattern = "Write"
`;
  await fs.writeFile(home + '/config.toml', config, { mode: 0o600 });
  await fs.writeFile(home + '/SYSTEM.md', 'You are testing a fictional meeting. Use Read to read '+workspace+'/transcript.txt. Use Write to create '+workspace+'/notes.md with concise factual Markdown. Include names, deadlines and budget. Then give one short completion sentence.');
  const sdk = await phase('sdk_import', () => import('/probe/kimi/sdk/index.mjs'));
  if (typeof sdk.createKimiHarness !== 'function') throw Error('missing_harness');
  if (mode !== 'import') {
    harness = await phase('harness_create', () => sdk.createKimiHarness({ homeDir: home,
      configPath: home + '/config.toml', identity: { productName: 'Alma Kimi Compatibility Probe', version: '0.1.0', platform: 'alma_kimi_probe' },
      skillDirs: [home + '/empty-skills'], telemetry: { track() {}, async flush() {} }, uiCapabilities: [] }));
    session = await phase('session_create', () => harness.createSession({ workDir: workspace,
      model: 'fixture', permission: 'manual', thinking: 'low' }));
    session.setQuestionHandler(() => null);
    session.setApprovalHandler(async request => {
      const path = request.display?.path;
      const allowed = (request.toolName === 'Read' && path === workspace + '/transcript.txt') ||
        (request.toolName === 'Write' && path === workspace + '/notes.md');
      emit('approval', { tool: request.toolName, path, allowed });
      return { decision: allowed ? 'approved' : 'rejected' };
    });
    const state = await phase('configuration_readback', () => session.reloadSession());
    const main = Object.values(state.agents).find(a => a.type === 'main');
    const tools = main?.tools.filter(t => t.active).map(t => t.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(['Read', 'Write'])) throw Error('configuration_tools_drift');
    if (!tools.every(tool => main.permission.rules.some(r => r.pattern === tool && r.decision === 'ask' && r.scope === 'user')))
      throw Error('configuration_permission_drift');
    emit('configuration', { tools });
    if (mode === 'fixture' || mode === 'cancel' || live) {
      let resolveEnd;
      const ended = new Promise(resolve => { resolveEnd = resolve; });
      session.onEvent(event => {
        events.push(event.type);
        if (event.type === 'tool.call.started') toolNames.set(event.toolCallId, event.name);
        if (event.type === 'tool.result') toolResults.push({ name: toolNames.get(event.toolCallId), isError: event.isError === true, synthetic: event.synthetic === true });
        if (['tool.call.started', 'tool.result', 'turn.ended'].includes(event.type))
          emit('native_event', { event: event.type, tool: event.name, isError: event.isError, reason: event.reason });
        if (event.type === 'turn.ended') resolveEnd(event);
      });
      const terminal = await phase('fixture_turn', async () => {
        await session.prompt(live ? 'Read the transcript file, then write short English structured notes with summary and action items. Preserve all names, deadlines, and the budget from the file.' : 'Run the controlled offline fixture.', { promptId: 'probe-' + mode });
        return await ended;
      });
      if (terminal.reason !== (mode === 'cancel' ? 'cancelled' : 'completed'))
        throw Error('unexpected_terminal:' + JSON.stringify(terminal));
      if (mode === 'fixture' && (requests !== 3 || await fs.readFile(workspace + '/notes.md', 'utf8') !== expected))
        throw Error('fixture_readback_mismatch');
      if (mode === 'fixture' && (!readContentRoundTrip || toolResults.length !== 2 || toolResults.some(result => result.isError || result.synthetic)))
        throw Error('real_tool_result_assertion_failed');
      if (live) {
        const notes = await fs.readFile(workspace + '/notes.md', 'utf8');
        if (!['Alice', 'Bob', 'Friday', 'Thursday', '500'].every(text => notes.includes(text)) || !readContentRoundTrip || !['Read','Write'].every(name => toolResults.some(result => result.name === name)) || toolResults.some(result => result.isError || result.synthetic))
          throw Error('live_note_validation_failed');
        emit('live_note_checked', { bytes: Buffer.byteLength(notes), factsPresent: true });
      }
    }
    await phase('session_close', () => session.close()); session = undefined;
    await phase('harness_close', () => harness.close()); harness = undefined;
  }
  if (networkAttempts.length) throw Error('unexpected_network_attempts');
  // Allow pending promise failures to surface instead of masking them with exit.
  await new Promise(resolve => setTimeout(resolve, 100));
  success = true;
} catch (error) {
  emit('failure', { name: error.name, message: String(error.message).slice(0,1600), stack: String(error.stack).slice(0,4000) });
} finally {
  try { await session?.close(); await harness?.close(); } catch (error) { success = false; emit('cleanup_failure', { message: String(error.message) }); }
  clearTimeout(deadline);
  closeTransport?.();
  emit('result', { success, mode, requests, networkAttempts, phases, eventCount: events.length, readContentRoundTrip, toolResults });
  process.exit(success ? 0 : 1);
}
