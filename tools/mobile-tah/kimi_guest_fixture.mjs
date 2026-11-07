// Offline integration of the shipped ESM entry, official SDK and host pipe frames.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const ish = process.argv.includes('--ish');
const packagedRuntime = process.argv.find(value => value.startsWith('--runtime='))?.slice('--runtime='.length);
const extendedRootfs = process.argv.find(value => value.startsWith('--rootfs='))?.slice('--rootfs='.length);
if (ish && !extendedRootfs) throw new Error('--ish requires --rootfs=<APK-installed fakefs directory>');
const lab = path.resolve(here, '../alma-ios-lab/.cache');
const probe = path.resolve(here, '../kimi-mobile-probe/.cache/latest-release');
execFileSync(process.execPath, [path.join(here, 'build_kimi_guest.mjs')], { stdio: 'ignore' });
const manifest = JSON.parse(fs.readFileSync(path.join(here, '.cache/kimi-guest/manifest.json')));
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alma-kimi-entry-')));
const runtime = path.join(temporary, 'runtime');
if (packagedRuntime) {
  fs.cpSync(packagedRuntime, runtime, { recursive: true });
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(runtime, 'guest.mjs'))).digest('hex'), manifest.sha256,
    'Package the current guest before running its integration fixture');
} else {
  fs.mkdirSync(runtime); fs.mkdirSync(path.join(runtime, 'node_modules'));
  fs.copyFileSync(path.join(here, '.cache/kimi-guest/guest.mjs'), path.join(runtime, 'guest.mjs'));
  const install = (source, target) => ish ? fs.cpSync(source, target, { recursive: true, dereference: true }) : fs.symlinkSync(source, target, 'dir');
  install(path.join(probe, 'artifact/opt/kimi/sdk'), path.join(runtime, 'sdk'));
  if (ish) fs.cpSync(path.join(probe, 'artifact/opt/kimi/node_modules'), path.join(runtime, 'node_modules'), { recursive: true });
  for (const [name, version] of Object.entries(manifest.compatibilityPackages)) {
    install(path.join(probe, `source/node_modules/.pnpm/${name}@${version}/node_modules/${name}`), path.join(runtime, 'node_modules', name));
  }
}
if (ish) {
  fs.cpSync(extendedRootfs, path.join(temporary, 'fs'), { recursive: true });
  const provenance = JSON.parse(fs.readFileSync(path.join(lab, 'ish-host-build-provenance.json')));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(lab, 'ish-host-build/ish'))).digest('hex'), provenance.binarySHA256);
  // Create nested mount parents through fakefs so its metadata stays authoritative.
  const preflight = execFileSync(path.join(lab, 'ish-host-build/ish'), ['-f', path.join(temporary, 'fs'), '/bin/sh', '-c',
    'mkdir -p /workspace/.runtime && /usr/bin/rg --version && printf "ALMA_RG_READY\\n"'],
    { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin' } });
  assert.ok(preflight.includes('ALMA_RG_READY'), 'Extended fakefs must execute its APK-installed rg');
}
const prefix = '__ALMA_KIMI__';
const input = 'ALMA_ENTRY_FIXTURE: Alice Friday, Bob Thursday, budget 500. 中文 🧪';
const output = '# Notes\nAlice Friday. Bob Thursday. Budget 500. 中文 🧪\n';
const editedOutput = output.replace('Budget 500.', 'Budget 500 dollars.');
const abilities = ['prompt.inline_text', 'workspace.entries.list', 'workspace.text.read', 'workspace.text.search'];
const sdkLock = JSON.parse(fs.readFileSync(path.resolve(here, '../kimi-mobile-probe/latest-source.lock.json')));
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(runtime, 'sdk/index.mjs'))).digest('hex'), sdkLock.sdkIndexSHA256);

async function run(mode) {
  const directory = path.join(temporary, mode), hostWorkspace = directory + '/workspace', hostScratch = directory + '/scratch';
  const workspaceRoot = ish ? '/workspace/attempt' : hostWorkspace, scratchRoot = ish ? '/workspace/scratch' : hostScratch;
  fs.mkdirSync(hostWorkspace, { recursive: true }); fs.mkdirSync(hostScratch); fs.mkdirSync(hostWorkspace + '/out');
  fs.writeFileSync(hostWorkspace + '/input.txt', input);
  const guardian = mode.endsWith('guardian');
  const attempt = { contractVersion: 1, attemptID: randomUUID(), providerID: 'kimi', role: guardian ? mode : 'actor',
    inference: { modelID: 'kimi-for-coding', reasoningEffortID: 'low' },
    prompt: [{ authority: 'tah_instruction', text: 'Read input.txt. Write out/notes.md for Actor. Return JSON for Guardian.' }],
    workspace: { materials: [{ relativePath: 'input.txt', mediaType: 'text/plain', byteLength: Buffer.byteLength(input), sha256: createHash('sha256').update(input).digest('hex') }], candidateSeeds: [], writableRoots: guardian ? [] : ['out'] },
    responseExpectation: guardian ? { kind: 'strict_json', schemaID: 'fixture/v1', maximumUTF8Bytes: 4096 }
      : { kind: 'workspace_outcome', contractID: 'fixture/v1', maximumFinalMessageUTF8Bytes: 4096 },
    requiredAbilities: guardian ? abilities : [...abilities, 'workspace.text.write', 'workspace.text.edit', ...(mode === 'web' ? ['web'] : [])] };
  const executable = ish ? '/usr/bin/python3' : process.execPath;
  const argv = ish ? [path.resolve(here, '../kimi-mobile-probe/pipe-host.py'), path.join(lab, 'ish-host-build/ish'),
    '-f', path.join(temporary, 'fs'), '/bin/sh', '-c',
    'env -i PATH=/usr/bin:/bin HOME=/workspace/scratch/home KIMI_CODE_HOME=/workspace/scratch/home TMPDIR=/workspace/scratch node --jitless /workspace/.runtime/kimi/guest.mjs; rc=$?; printf \"\\n__ALMA_GUEST_EXIT__:%d\\n\" \"$rc\"; exit \"$rc\"']
    : ['--jitless', path.join(runtime, 'guest.mjs')];
  const child = spawn(executable, argv, {
    cwd: hostWorkspace, stdio: ['pipe', 'pipe', 'pipe'], detached: ish,
    env: { PATH: process.env.PATH, HOME: scratchRoot + '/home', TMPDIR: scratchRoot, LANG: 'C.UTF-8',
      ...(ish ? { ISH_BIND_MOUNTS: `/workspace/.runtime/kimi=${runtime}:ro,/workspace/attempt=${hostWorkspace}:rw,/workspace/scratch=${hostScratch}:rw` } : {}) },
  });
  let failure, terminal, stderr = '', diagnostics = '', requests = 0, acknowledgements = 0, cancellations = 0, readBack = false;
  const events = [], pending = new Map(), webRequests = [];
  const stop = error => { failure ??= error; if (ish) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } else child.kill('SIGKILL'); };
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const timer = setTimeout(() => stop(Error(`guest deadline: ${mode}`)), ish ? 120000 : 20000);
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) stop(Error('stderr limit')); });
  child.stdin.on('error', error => { if (!terminal) stop(error); });
  const next = id => {
    const chunks = pending.get(id);
    assert.ok(chunks, 'ACK belongs to an active response');
    const data = chunks.shift();
    if (data) send({ kind: 'chunk', id, data: data.toString('base64') });
    else { pending.delete(id); send({ kind: 'end', id }); }
  };
  const respond = (id, bytes, contentType) => {
    // Deliberately split UTF-8 and SSE records across host transport chunks.
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 31) chunks.push(bytes.subarray(offset, offset + 31));
    pending.set(id, chunks);
    send({ kind: 'headers', id, status: 200, headers: { 'content-type': contentType } });
    next(id);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      if (!line.startsWith(prefix)) { diagnostics = (diagnostics + line + '\n').slice(-8192); return; } // SDK diagnostics have no protocol authority.
      const frame = JSON.parse(line.slice(prefix.length));
      assert.equal(terminal, undefined, 'no protocol frames after terminal');
      if (frame.kind === 'http') {
        assert.equal(frame.method, 'POST');
        assert.equal(frame.headers.authorization, 'Bearer sk-alma-native-placeholder-000000000000');
        const body = JSON.parse(frame.body);
        if (frame.url.endsWith('/search')) {
          assert.equal(mode, 'web'); webRequests.push('search');
          respond(frame.id, Buffer.from(JSON.stringify({ search_results: [{ title: 'Fixture', url: 'https://example.com/fixture', snippet: 'Fixture facts' }] })), 'application/json'); return;
        }
        if (frame.url.endsWith('/fetch')) {
          assert.equal(mode, 'web'); webRequests.push('fetch');
          respond(frame.id, Buffer.from('Fixture facts 中文 🧪'), 'text/markdown'); return;
        }
        assert.equal(frame.url, 'https://api.kimi.com/coding/v1/chat/completions');
        assert.equal(body.model, attempt.inference.modelID);
        assert.equal(body.thinking.type, 'enabled'); assert.equal(body.thinking.effort, 'low');
        requests++;
        if (mode === 'cancel') { send({ kind: 'cancel' }); return; }
        if (requests === 2) {
          readBack = body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('ALMA_ENTRY_FIXTURE'));
          assert.ok(readBack, 'native Read output reached a subsequent request');
        }
        const operations = [['Read', { path: workspaceRoot + '/input.txt' }],
          ['Glob', { path: workspaceRoot, pattern: '*.txt' }],
          ['Grep', { path: workspaceRoot, pattern: 'ALMA_ENTRY_FIXTURE', output_mode: 'content' }]];
        if (requests === 3 || requests === 4) {
          const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === `tool-${requests - 1}`);
          assert.ok(result && JSON.stringify(result.content).includes('input.txt'), 'real Glob/Grep result reached model: ' + JSON.stringify(result));
          if (requests === 4) assert.ok(JSON.stringify(result.content).includes('ALMA_ENTRY_FIXTURE'));
        }
        if (!guardian) operations.push(['Write', { path: workspaceRoot + '/out/notes.md', content: output }],
          ['Read', { path: workspaceRoot + '/out/notes.md' }],
          ['Edit', { path: workspaceRoot + '/out/notes.md', old_string: 'Budget 500.', new_string: 'Budget 500 dollars.' }]);
        if (mode === 'web') operations.push(['WebSearch', { query: 'fixture facts' }], ['FetchURL', { url: 'https://example.com/fixture' }]);
        const operation = operations[requests - 1];
        const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1,
          model: attempt.inference.modelID, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
        let data = chunk({ role: 'assistant' });
        if (operation) data += chunk({ tool_calls: [{ index: 0, id: `tool-${requests}`, type: 'function', function: { name: operation[0], arguments: JSON.stringify(operation[1]) } }] }) + chunk({}, 'tool_calls');
        else data += chunk({ content: guardian ? '{"safe":true}' : 'Done 中文 🧪.' }) + chunk({}, 'stop');
        respond(frame.id, Buffer.from(data + 'data: [DONE]\n\n'), 'text/event-stream');
      } else if (frame.kind === 'httpAck') { acknowledgements++; next(frame.id); }
      else if (frame.kind === 'httpCancel') { cancellations++; pending.delete(frame.id); }
      else if (frame.kind === 'event') {
        assert.equal(frame.event.attemptID, attempt.attemptID);
        assert.equal(frame.event.sequence, events.length + 1);
        events.push(frame.event);
      } else {
        assert.equal(frame.kind, 'terminal'); terminal = frame.terminal;
        assert.equal(fs.existsSync(hostScratch + '/home'), false, 'terminal follows private home cleanup');
      }
    } catch (error) { stop(error); }
  });
  const exit = new Promise(resolve => { child.once('error', stop); child.once('close', (code, signal) => resolve({ code, signal })); });
  send({ kind: 'start', attempt, workspaceRoot, scratchRoot });
  const result = await exit;
  clearTimeout(timer); lines.close();
  if (failure) throw failure;
  assert.equal(result.code, 0, stderr);
  if (ish) assert.match(diagnostics, /__ALMA_GUEST_EXIT__:0(?:\n|$)/u, 'guest shell confirms exit after complete protocol drain');
  assert.equal(pending.size, 0, 'HTTP work drained');
  assert.equal(terminal?.kind, mode === 'cancel' ? 'cancelled' : 'end_turn', JSON.stringify({ terminal, requests, eventCount: events.length, events, stderr, diagnostics }));
  if (mode === 'cancel') assert.equal(cancellations, 1);
  else {
    assert.ok(readBack); assert.ok(acknowledgements > 0);
    assert.equal(events.some(event => event.kind === 'tool_completed' && event.status === 'failed'), false);
    const required = guardian ? ['text_read', 'workspace_list', 'text_search'] : ['text_read', 'workspace_list', 'text_search', 'text_write', 'text_edit'];
    for (const operation of required) assert.ok(events.some(event => event.kind === 'tool_started' && event.operation === operation));
    const final = events.find(event => event.kind === 'message_started' && event.role === 'final_answer');
    assert.equal(final.messageID, terminal.finalMessageID);
    assert.equal(events.filter(event => event.kind === 'message_delta' && event.messageID === final.messageID).map(event => event.text).join(''), terminal.finalText);
    if (!guardian) assert.equal(fs.readFileSync(hostWorkspace + '/out/notes.md', 'utf8'), editedOutput);
    if (mode === 'web') assert.deepEqual(webRequests, ['search', 'fetch']);
  }
  if (ish) process.stderr.write(JSON.stringify({ mode, passed: true, requests, events: events.length }) + '\n');
  return { mode, passed: true, requests, acknowledgements, cancellations, events: events.length, terminal: terminal.kind };
}
try {
  const results = [];
  for (const mode of ['actor', 'raw_guardian', 'extra_guardian', 'web', 'cancel']) results.push(await run(mode));
  console.log(JSON.stringify({ hostNode: process.version, execution: ish ? 'iSH Linux Node 22.23.4 with POSIX pipes' : 'Mac Node', jitless: true, guestSHA256: manifest.sha256, sdkVersion: sdkLock.releaseVersion,
    accountUsed: false, ...(ish ? { rootfs: path.resolve(extendedRootfs), guestEntry: '/workspace/.runtime/kimi/guest.mjs' } : {}), results }, null, 2));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
