// Run with Node 22+: node --test tools/kimi-mobile-probe/pipe-fetch.test.mjs
// Optional ALMA_KIMI_TEST_NODE_FETCH points to a cached node-fetch src/index.js.
// Parent supplies synthetic HTTP frames. Guest uses the real pipe-fetch module.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const directory = path.dirname(filename);
const prefix = '__KIMI_HTTP__';
const fixtureURL = 'https://pipe-fetch-test.invalid/synthetic';
const expectedBody = Buffer.from('First chunk 🧪\nSecond chunk.');
const chunks = [expectedBody.subarray(0, 14), expectedBody.subarray(14)];

async function cachedNodeFetch() {
  if (process.env.ALMA_KIMI_TEST_NODE_FETCH) {
    const entry = path.resolve(process.env.ALMA_KIMI_TEST_NODE_FETCH);
    await access(entry);
    return entry;
  }
  const cache = path.join(directory, '.cache');
  const prepared = path.join(cache, 'latest-release/source/node_modules/.pnpm/node-fetch@3.3.2/node_modules/node-fetch/src/index.js');
  try { await access(prepared); return prepared; } catch { /* Check retained probe payloads next. */ }
  for (const run of (await readdir(cache)).sort()) {
    const entry = path.join(cache, run, 'payload/runtime/node_modules/node-fetch/src/index.js');
    try { await access(entry); return entry; } catch { /* Try the next cached run. */ }
  }
  throw Error('Cached node-fetch missing. Set ALMA_KIMI_TEST_NODE_FETCH to its src/index.js.');
}

async function guest(scenario, fetchEntry) {
  const denyNetwork = () => { throw Error('Unexpected real network access in pipe regression'); };
  net.connect = denyNetwork;
  net.createConnection = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  const bindings = await import(pathToFileURL(fetchEntry).href);
  for (const name of ['Headers', 'Request', 'Response']) globalThis[name] = bindings[name];
  globalThis.fetch = denyNetwork;
  const { installPipeFetch } = await import('./pipe-fetch.mjs');
  const closeTransport = installPipeFetch();
  const controller = new AbortController();
  // Install the command listener before emitting the request to avoid IPC races.
  const command = scenario === 'chunk-ack' ? null : once(process, 'message');
  try {
    const pending = fetch(fixtureURL, {
      method: 'POST', body: 'synthetic request', signal: controller.signal,
    });
    if (scenario === 'abort-headers') {
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      const [message] = await command;
      assert.equal(message.kind, 'abort');
      controller.abort();
      const { error } = await outcome;
      assert.ok(error instanceof Error, 'fetch must reject when aborted before headers');
      assert.match(error.message, /abort/i);
    } else {
      const response = await pending;
      assert.equal(response.status, 200);
      if (scenario === 'body-destroy') {
        const [message] = await command;
        assert.equal(message.kind, 'destroy');
        const closed = once(response.body, 'close');
        response.body.destroy();
        await closed;
      } else {
        assert.equal(scenario, 'chunk-ack');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedBody);
      }
    }
    await new Promise((resolve, reject) => {
      process.send({ kind: 'guest-complete', scenario }, error => error ? reject(error) : resolve());
    });
  } finally {
    closeTransport();
    process.disconnect();
  }
}

async function runCase(scenario, fetchEntry) {
  const child = spawn(process.execPath, [filename, '--guest', scenario, fetchEntry], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: {},
  });
  let failure;
  let stderr = '';
  let requestID;
  let requestCount = 0;
  let acknowledgements = 0;
  let cancellations = 0;
  let completed = false;
  const fail = error => { failure ??= error; child.kill('SIGKILL'); };
  const exit = new Promise(resolve => {
    child.once('error', fail);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => fail(Error(
    `${scenario} exceeded 5s: requests=${requestCount}, ACKs=${acknowledgements}, cancels=${cancellations}`,
  )), 5000);
  const lines = createInterface({ input: child.stdout });
  const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
  const sendChunk = index => send({ id: requestID, kind: 'chunk', data: chunks[index].toString('base64') });
  child.stdin.on('error', fail);
  child.stderr.on('data', bytes => {
    stderr += bytes.toString();
    if (stderr.length > 65536) fail(Error('Guest stderr exceeded 64 KiB'));
  });
  child.on('message', message => {
    try {
      assert.deepEqual(message, { kind: 'guest-complete', scenario });
      assert.equal(completed, false, 'guest completion must occur once');
      completed = true;
    } catch (error) { fail(error); }
  });
  lines.on('line', line => {
    try {
      assert.ok(line.startsWith(prefix), `Unexpected guest stdout: ${line}`);
      const frame = JSON.parse(line.slice(prefix.length));
      if (frame.kind === 'request') {
        assert.equal(++requestCount, 1, 'only one synthetic request is permitted');
        assert.equal(frame.id, 1);
        assert.equal(frame.url, fixtureURL);
        assert.equal(frame.method, 'POST');
        assert.equal(frame.body, 'synthetic request');
        requestID = frame.id;
        if (scenario === 'abort-headers') {
          child.send({ kind: 'abort' });
        } else {
          send({ id: requestID, kind: 'headers', status: 200, headers: {} });
          sendChunk(0);
          if (scenario === 'body-destroy') child.send({ kind: 'destroy' });
        }
      } else {
        assert.equal(frame.id, requestID, 'frame must belong to the active request');
        if (frame.kind === 'cancel') {
          assert.notEqual(scenario, 'chunk-ack', 'normal EOF must complete without cancellation');
          assert.equal(++cancellations, 1, 'cancellation must be emitted exactly once');
        } else {
          assert.equal(frame.kind, 'ack');
          assert.equal(scenario, 'chunk-ack', 'unconsumed or aborted response must not ACK');
          acknowledgements++;
          assert.ok(acknowledgements <= chunks.length, 'unexpected duplicate ACK');
          // Deliberately withhold each next chunk/end until the preceding ACK.
          if (acknowledgements < chunks.length) sendChunk(acknowledgements);
          else send({ id: requestID, kind: 'end' });
        }
      }
    } catch (error) { fail(error); }
  });
  try {
    const result = await exit;
    if (failure) throw failure;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0, stderr);
    assert.equal(requestCount, 1);
    assert.equal(completed, true, 'guest assertions must complete');
    assert.equal(cancellations, scenario === 'chunk-ack' ? 0 : 1, 'missing cancellation frame');
    assert.equal(acknowledgements, scenario === 'chunk-ack' ? chunks.length : 0, 'missing chunk ACK');
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.destroy();
  }
}

if (process.argv[2] === '--guest') {
  await guest(process.argv[3], process.argv[4]);
} else {
  const { test } = await import('node:test');
  const fetchEntry = await cachedNodeFetch();
  for (const scenario of ['body-destroy', 'abort-headers', 'chunk-ack']) {
    test(scenario, { timeout: 7000 }, () => runCase(scenario, fetchEntry));
  }
}
