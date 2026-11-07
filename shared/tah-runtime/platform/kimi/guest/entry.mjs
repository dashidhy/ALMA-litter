import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';

let terminalSent = false;
const send = frame => {
  if (frame.kind === 'terminal') terminalSent = true;
  const bytes = Buffer.from('__ALMA_KIMI__' + JSON.stringify(frame) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(1, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error('kimi_transport_write_failed');
    offset += count;
  }
};

function fatalCategory(error) {
  if (['EACCES', 'EPERM', 'ERR_ACCESS_DENIED'].includes(error?.code)) return 'kimi_guest_fs_denied';
  if (['ENOENT', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) return 'kimi_guest_module_missing';
  if (String(error?.message).includes('WebAssembly')) return 'kimi_guest_wasm_unavailable';
  if (error instanceof SyntaxError) return 'kimi_guest_syntax_error';
  if (error instanceof TypeError) return 'kimi_guest_type_error';
  if (/^(E[A-Z_0-9]{2,40}|ERR_[A-Z_0-9]{1,60})$/.test(String(error?.code))) return 'kimi_guest_' + error.code.toLowerCase();
  if (String(error?.message) === 'kimi_direct_network_denied') return 'kimi_guest_direct_network_denied';
  const sdkLocation = String(error?.stack).match(/\/sdk\/index\.mjs:(\d+):(\d+)/);
  if (sdkLocation) return 'kimi_guest_sdk_at_' + sdkLocation[1] + '_' + sdkLocation[2];
  return 'kimi_guest_unhandled_failure';
}
function reportFatal(error) {
  if (!terminalSent) send({ kind: 'terminal', terminal: { kind: 'failed', failure: {
    family: 'protocol', code: fatalCategory(error), retryable: false,
    message: 'Kimi guest runtime stopped unexpectedly.' } } });
  process.exit(1);
}
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

import { parseStart, runKimiGuest } from './runner.js';
import { createPipeFetch } from './pipe-fetch.js';

// Run each tool through preparation, execution and finalization in order.
process.env.ALMA_KIMI_SERIAL_TOOLS = '1';

// Linux Node/iSH cannot use Undici's Wasm paths. Install the probe-qualified
// pure-JS bindings before loading the SDK or enumerating node:http exports.
const http = createRequire(import.meta.url)('node:http');
for (const name of ['WebSocket', 'CloseEvent', 'MessageEvent']) {
  Object.defineProperty(http, name, { value: class { constructor() { throw new Error('kimi_websocket_unsupported'); } }, configurable: true, enumerable: true });
}
for (const name of ['Headers', 'Request', 'Response', 'FormData', 'WebSocket', 'EventSource']) {
  delete globalThis[name];
  Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true });
}
const bindings = await import('node-fetch');
for (const name of ['Headers', 'Request', 'Response', 'FormData']) {
  Object.defineProperty(globalThis, name, { value: bindings[name], writable: true, configurable: true });
}
const denySocket = () => { throw new Error('kimi_direct_network_denied'); };
net.connect = denySocket;
net.createConnection = denySocket;
net.Socket.prototype.connect = denySocket;
// ReadWeb's local fallback resolves DNS before fetch. Reject that path before
// it can use the guest resolver, as well as denying its eventual URL request.
dns.lookup = denySocket;
dnsPromises.lookup = denySocket;
// The native resolver reads ancestor directories. Node's callback resolver
// uses the traversal/stat operations supported by the same scoped grants.
const nodeFS = createRequire(import.meta.url)('node:fs');
const { promisify } = createRequire(import.meta.url)('node:util');
nodeFS.promises.realpath = promisify(nodeFS.realpath);
syncBuiltinESMExports();

const abort = new AbortController();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let transport, started = false, completed = false;
let resolveStart, rejectStart;
const ready = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
const failInput = () => { abort.abort(); transport?.close(); rejectStart(new Error('kimi_invalid_host_frame')); };
lines.on('line', line => {
  try {
    if (line.length > 8 * 1024 * 1024) throw new Error('kimi_frame_limit');
    const frame = JSON.parse(line);
    if (!started) {
      const start = parseStart(frame);
      started = true;
      transport = createPipeFetch(send, start.attempt.requiredAbilities.includes('web'));
      globalThis.fetch = transport.fetch;
      resolveStart(start);
    } else if (frame.kind === 'cancel') { abort.abort(); transport.close(); }
    else if (Number.isSafeInteger(frame.id) && frame.id > 0 && ['headers', 'chunk', 'end', 'error'].includes(frame.kind)) transport.receive(frame);
    else failInput();
  } catch { failInput(); }
});
lines.on('close', () => { if (!completed) failInput(); });
try {
  const start = await ready;
  await runKimiGuest(start, abort.signal, frame => {
    if (frame.kind === 'terminal') transport.close();
    send(frame);
  }, () => import(new URL('./sdk/index.mjs', import.meta.url).href));
} catch {
  send({ kind: 'terminal', terminal: { kind: 'failed', failure: { family: 'protocol', code: 'kimi_guest_bridge_failed',
    retryable: false, message: 'Kimi guest bridge could not complete the attempt.' } } });
  process.exitCode = 1;
} finally {
  completed = true;
  transport?.close();
  lines.close();
  process.stdin.pause();
}
