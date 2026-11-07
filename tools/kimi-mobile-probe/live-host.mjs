import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const [runDirectory, tokenFile] = process.argv.slice(2);
if (!runDirectory || !tokenFile) throw Error('Expected run directory and private token file');
const work = fs.realpathSync(runDirectory);
const root = path.resolve(import.meta.dirname, '..', '..');
if (!work.startsWith(path.join(import.meta.dirname, '.cache') + path.sep)) throw Error('Unexpected run directory');
const key = fs.readFileSync(tokenFile, 'utf8').trim();
if (!key.startsWith('sk-kimi-')) throw Error('Invalid test credential');
const log = fs.createWriteStream(path.join(work, 'live-guest.jsonl'), { flags: 'wx', mode: 0o600 });
const errors = fs.createWriteStream(path.join(work, 'live-stderr.txt'), { flags: 'wx', mode: 0o600 });
const started = performance.now();
const requests = [];
const operations = new Map();
const tasks = new Set();
let terminal;
let fatal;
let guestExit;
let peakRSSBytes = 0;
let sampling = false;
let guestHostPID;
const child = spawn('/usr/bin/python3',
  [path.join(import.meta.dirname, 'pipe-host.py'), path.join(root, 'tools/alma-ios-lab/.cache/ish-host-build/ish'),
    '-f', path.join(work, 'fs'), '/bin/sh', '-c',
    'env -i PATH=/usr/bin:/bin HOME=/probe-work/home TMPDIR=/tmp ALMA_KIMI_FETCH_BINDINGS=node-fetch node /probe/probe.mjs live; rc=$?; printf "\\n__ALMA_GUEST_EXIT__:%d\\n" "$rc"; exit "$rc"'],
  { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: '/usr/bin:/bin',
    ISH_BIND_MOUNTS: `/probe=${work}/payload:ro,/probe-work=${work}/workspace:rw`,
  } });
const redact = text => text.replaceAll(key, '[redacted]');
const stop = () => {
  for (const operation of operations.values()) operation.controller.abort();
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
};
const deadline = setTimeout(() => { fatal = 'host_deadline'; stop(); }, 240000);
const sampler = setInterval(() => {
  if (sampling) return;
  sampling = true;
  execFile('/bin/ps', ['-o', 'rss=', '-p', String(guestHostPID ?? child.pid)], { timeout: 2000 }, (error, stdout) => {
    sampling = false;
    const rss = Number(stdout.trim()) * 1024;
    if (!error && Number.isFinite(rss)) peakRSSBytes = Math.max(peakRSSBytes, rss);
    if (peakRSSBytes > 1536 * 1024 * 1024) { fatal = 'rss_guard'; stop(); }
  });
}, 1000);
const send = async frame => {
  if (!child.stdin.write(JSON.stringify(frame) + '\n')) await once(child.stdin, 'drain');
};
child.stdin.on('error', () => {});
await send({ kind: 'hello', id: 0 });
child.stderr.on('data', bytes => errors.write(redact(bytes.toString())));
async function request(frame) {
  const url = new URL(frame.url);
  const routes = new Set(['/coding/v1/chat/completions', '/coding/v1/messages', '/coding/v1/models', '/coding/v1/search', '/coding/v1/fetch']);
  if (url.origin !== 'https://api.kimi.com' || !routes.has(url.pathname) || url.search || url.username || url.password)
    throw Error('request_target_denied');
  if (!['GET', 'POST'].includes(frame.method) || typeof frame.body !== 'string' && frame.body !== null || Buffer.byteLength(frame.body ?? '') > 262144)
    throw Error('request_shape_denied');
  if (requests.length >= 6 || operations.has(frame.id)) throw Error('request_budget_exceeded');
  const controller = new AbortController();
  const operation = { controller, ack: undefined };
  operations.set(frame.id, operation);
  const record = { path: url.pathname, startedMs: performance.now() - started, status: null, bytes: 0 };
  requests.push(record);
  log.write(JSON.stringify({ type: 'broker_request', id: frame.id, path: url.pathname }) + '\n');
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const headers = new Headers(frame.headers);
    headers.set('Authorization', 'Bearer ' + key);
    headers.delete('host');
    const response = await fetch(url, { method: frame.method, headers, body: frame.body,
      signal: controller.signal, redirect: 'error' });
    record.status = response.status;
    log.write(JSON.stringify({ type: 'broker_response', id: frame.id, status: response.status }) + '\n');
    await send({ id: frame.id, kind: 'headers', status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' } });
    for await (const bytes of response.body) {
      record.bytes += bytes.length;
      if (record.bytes > 2097152) throw Error('response_budget_exceeded');
      // The C-host console input line buffer is 4096 bytes. Keep base64 frames
      // comfortably below it. Production owned pipes use their own byte caps.
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        let timer;
        let rejectOnAbort;
        const acknowledged = new Promise((resolve, reject) => {
          operation.ack = resolve;
          rejectOnAbort = () => reject(Error('request_aborted'));
          controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
          if (controller.signal.aborted) rejectOnAbort();
          timer = setTimeout(() => reject(Error('consumer_ack_timeout')), 30000);
        });
        try {
          await send({ id: frame.id, kind: 'chunk', data: Buffer.from(bytes.subarray(offset, offset + 1024)).toString('base64') });
          await acknowledged;
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', rejectOnAbort);
          operation.ack = undefined;
        }
      }
    }
    await send({ id: frame.id, kind: 'end' });
  } finally {
    record.elapsedMs = performance.now() - started - record.startedMs;
    clearTimeout(timeout);
    operations.delete(frame.id);
  }
}
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  if (!line.startsWith('__KIMI_HTTP__')) {
    if (line.startsWith('__KIMI_CHILD_PID__:')) { guestHostPID = Number(line.split(':')[1]); return; }
    if (line.startsWith('__ALMA_GUEST_EXIT__:')) guestExit = Number(line.split(':')[1]);
    log.write(redact(line) + '\n');
    try { const value = JSON.parse(line); if (value.type === 'result') terminal = value; } catch {}
    return;
  }
  let frame;
  try { frame = JSON.parse(line.slice('__KIMI_HTTP__'.length)); }
  catch { fatal = 'malformed_guest_transport'; stop(); return; }
  if (frame.kind === 'ack') { operations.get(frame.id)?.ack?.(); return; }
  if (frame.kind === 'cancel') { operations.get(frame.id)?.controller.abort(); return; }
  if (frame.kind !== 'request') { fatal = 'unknown_guest_transport'; stop(); return; }
  const task = request(frame).catch(async error => {
    fatal = redact(error.message);
    try { await send({ id: frame.id, kind: 'error', message: fatal }); } catch {}
  });
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
});
const [code, signal] = await once(child, 'close');
clearTimeout(deadline);
clearInterval(sampler);
for (const operation of operations.values()) operation.controller.abort();
await Promise.allSettled([...tasks]);
log.end(); errors.end();
const report = { scope: 'Mac iSH guest with native-host HTTPS broker', realModel: true,
  credentialDeliveredToGuest: false, hostSeconds: (performance.now() - started) / 1000,
  hostExit: code, guestExit, peakRSSBytes, signal, fatal, brokerDrained: operations.size === 0,
  passed: code === 0 && guestExit === 0 && !fatal && terminal?.success === true && operations.size === 0 && requests.some(r => r.status === 200 && r.bytes > 0),
  requests, terminal };
fs.writeFileSync(path.join(work, 'live-summary.json'), redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, seconds: report.hostSeconds, fatal, requests, terminalSuccess: terminal?.success }));
process.exitCode = report.passed ? 0 : 1;
