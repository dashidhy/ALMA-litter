import { Readable } from 'node:stream';

type Frame = { kind: string; id: number; [key: string]: any };
type RequestState = { frames: Frame[]; waiter?: (frame: Frame) => void; abort: () => void };

const transportFailures = new Set(['kimi_http_timeout', 'kimi_http_failed', 'kimi_response_limit',
  'kimi_headers_limit', 'kimi_redirect_denied', 'kimi_ack_timeout', 'kimi_http_cancelled']);
function responseError(frame: Frame, fallback: string): Error {
  return new Error(transportFailures.has(frame.message) ? frame.message : fallback);
}

/** One response chunk in flight. ACK follows consumer advancement, including UTF-8 split chunks. */
export function createPipeFetch(send: (frame: object) => void, webEnabled: boolean) {
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, RequestState>();
  const deliver = (request: RequestState, frame: Frame) => {
    if (request.waiter) { const resolve = request.waiter; request.waiter = undefined; resolve(frame); }
    else request.frames.push(frame);
  };
  const receive = (frame: Frame) => {
    const request = pending.get(frame.id);
    if (!request) return;
    if (!['headers', 'chunk', 'end', 'error'].includes(frame.kind) || request.frames.length >= 4) {
      request.abort();
      return;
    }
    deliver(request, frame);
  };
  const fetch = async (input: any, init: any = {}): Promise<Response> => {
    if (closed || init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    const model = ['/coding/v1/messages', '/coding/v1/chat/completions'].includes(url.pathname);
    const web = ['/coding/v1/fetch', '/coding/v1/search'].includes(url.pathname);
    // SDK ReadWeb's direct URL fallback is intentionally denied. The native
    // broker independently enforces this service and frozen-grant boundary.
    if (url.origin !== 'https://api.kimi.com' || url.username || url.password || url.search || url.hash || !(model || webEnabled && web)) {
      throw new Error('kimi_http_scope_denied');
    }
    if (init.body != null && typeof init.body !== 'string') throw new Error('kimi_http_body_unsupported');
    const id = ++sequence;
    let ended = false, cancelled = false, finished = false;
    const request: RequestState = { frames: [], abort: () => {} };
    const next = () => request.frames.length ? Promise.resolve(request.frames.shift()!)
      : new Promise<Frame>(resolve => { request.waiter = resolve; });
    const sendCancel = () => {
      if (cancelled) return;
      cancelled = true;
      send({ kind: 'httpCancel', id });
    };
    request.abort = () => {
      if (finished) return;
      sendCancel();
      request.frames.length = 0;
      deliver(request, { kind: 'error', id, message: 'request_aborted' });
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      pending.delete(id);
      init.signal?.removeEventListener('abort', request.abort);
      if (!ended) sendCancel();
    };
    pending.set(id, request);
    init.signal?.addEventListener('abort', request.abort, { once: true });
    try {
      send({ kind: 'http', id, url: url.href, method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ?? null });
      const head = await next();
      if (head.kind !== 'headers') throw responseError(head, 'kimi_http_headers_unavailable');
      if (!Number.isInteger(head.status) || head.status < 200 || head.status > 599) throw new Error('kimi_http_invalid_status');
      const stream = Readable.from((async function* () {
        try {
          for (;;) {
            const frame = await next();
            if (frame.kind === 'end') { ended = true; return; }
            if (frame.kind === 'error') throw responseError(frame, 'kimi_http_response_failed');
            if (frame.kind !== 'chunk' || typeof frame.data !== 'string' || frame.data.length > 1024 * 1024) {
              throw new Error('kimi_http_invalid_chunk');
            }
            const bytes = Buffer.from(frame.data, 'base64');
            if (bytes.toString('base64') !== frame.data) throw new Error('kimi_http_invalid_base64');
            yield bytes;
            send({ kind: 'httpAck', id });
          }
        } finally { finish(); }
      })());
      stream.once('close', () => { if (!finished) { request.abort(); finish(); } });
      // The guest always installs node-fetch's Node-stream Response binding.
      return new Response(stream as any, { status: head.status, headers: head.headers });
    } catch (error) { finish(); throw error; }
  };
  return { fetch, receive, close() { closed = true; for (const request of pending.values()) request.abort(); },
    get pendingRequests() { return pending.size; } };
}
