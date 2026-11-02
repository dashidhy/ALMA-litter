import { AppBridgeError } from "./bridge.js";

/** One RPC in flight; coalesce progress for each Action without dropping its
 * final state behind a burst of working events. Persistence remains authoritative. */
export class LatestAppNotifications<T> {
  readonly #queued = new Map<string, T>();
  #sending = false;
  #closed = false;
  constructor(private readonly deliver: (value: T) => Promise<unknown>, private readonly unavailable: () => void = () => {}) {}
  publish(key: string, value: T) {
    if (this.#closed) return;
    if (!this.#queued.has(key) && this.#queued.size >= 32) { this.close(); this.unavailable(); return; }
    this.#queued.set(key, value);
    if (!this.#sending) void this.#drain();
  }
  close() { this.#closed = true; this.#queued.clear(); }
  async #drain() {
    this.#sending = true;
    try {
      while (!this.#closed && this.#queued.size) {
        const [key, value] = this.#queued.entries().next().value!;
        this.#queued.delete(key);
        try { await this.deliver(value); }
        catch (error) {
          if (!(error instanceof AppBridgeError) || error.code !== "busy") { this.close(); this.unavailable(); return; }
          if (!this.#queued.has(key)) this.#queued.set(key, value);
          await new Promise(resolve => setTimeout(resolve, 16));
        }
      }
    } finally { this.#sending = false; }
  }
}
