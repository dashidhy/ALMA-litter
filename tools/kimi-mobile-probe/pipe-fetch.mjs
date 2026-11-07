import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { writeSync } from 'node:fs';

// Experimental transport seam for the real SDK. Credentials stay in the host.
export function installPipeFetch(onRequest = () => {}) {
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = value => {
    const bytes = Buffer.from('__KIMI_HTTP__' + JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(1, bytes, offset, bytes.length - offset);
      if (written <= 0) throw Error('transport_write_failed');
      offset += written;
    }
  };
  lines.on('line', line => {
    const frame = JSON.parse(line);
    const request = pending.get(frame.id);
    if (!request) return;
    if (request.waiter) {
      const resolve = request.waiter;
      request.waiter = undefined;
      resolve(frame);
    } else request.frames.push(frame);
  });
  globalThis.fetch = async (input, init = {}) => {
    const id = ++sequence;
    const request = { frames: [], waiter: undefined };
    pending.set(id, request);
    const next = () => request.frames.length ? Promise.resolve(request.frames.shift()) :
      new Promise(resolve => { request.waiter = resolve; });
    let cancelSent = false;
    const sendCancel = () => {
      if (cancelSent) return;
      cancelSent = true;
      send({ kind: 'cancel', id });
    };
    const abort = () => {
      sendCancel();
      const frame = { kind: 'error', message: 'request_aborted' };
      if (request.waiter) { request.waiter(frame); request.waiter = undefined; }
      else request.frames.push(frame);
    };
    if (init.signal?.aborted) { pending.delete(id); throw new DOMException('Aborted', 'AbortError'); }
    init.signal?.addEventListener('abort', abort, { once: true });
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    onRequest(url, init);
    send({ kind: 'request', id, url, method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ?? null });
    let ended = false;
    const finish = () => {
      pending.delete(id);
      init.signal?.removeEventListener('abort', abort);
      if (!ended) sendCancel();
    };
    try {
      const head = await next();
      if (head.kind !== 'headers') throw Error(head.message ?? 'missing_response_headers');
      const stream = Readable.from((async function* () {
        try {
          while (true) {
            const frame = await next();
            if (frame.kind === 'end') { ended = true; return; }
            if (frame.kind === 'error') throw Error(frame.message);
            if (frame.kind !== 'chunk') throw Error('unexpected_transport_frame');
            yield Buffer.from(frame.data, 'base64');
            send({ kind: 'ack', id });
          }
        } finally { finish(); }
      })());
      stream.once('close', () => { if (pending.has(id)) { abort(); finish(); } });
      return new Response(stream, { status: head.status, headers: head.headers });
    } catch (error) { finish(); throw error; }
  };
  return () => { lines.close(); process.stdin.pause(); };
}
