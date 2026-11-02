import { randomUUID } from "node:crypto";
import { z } from "zod";

export const APP_BRIDGE_VERSION = 1;
export const APP_BRIDGE_MAX_FRAME_BYTES = 128 * 1024;
export const APP_BRIDGE_MAX_PENDING = 32;
const identity = z.uuid();
const method = z.string().regex(/^[a-z][a-zA-Z.]{0,63}$/u);
export const appBridgeFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("request"), id: identity, method, value: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("response"), id: identity, value: z.unknown() }),
  z.strictObject({ version: z.literal(1), kind: z.literal("failure"), id: identity,
    code: z.enum(["unavailable", "invalid_request", "busy", "cancelled", "integrity_locked"]) }),
]).refine(frame => frame.kind === "failure" || (Object.hasOwn(frame, "value") && frame.value !== undefined));
export type AppBridgeFrame = z.infer<typeof appBridgeFrameSchema>;
export type AppBridgeHandler = (value: unknown) => Promise<unknown>;
export class AppBridgeError extends Error {
  public constructor(public readonly code: "unavailable" | "invalid_request" | "busy" | "cancelled" | "integrity_locked") {
    super(`TAH runtime bridge: ${code}`);
  }
}

/** Private, bounded Service ↔ Node RPC. This is neither App XPC nor Guest wire. */
export class AppRuntimeBridge {
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #incoming = new Set<string>();
  #buffer = Buffer.alloc(0);
  #writeTail: Promise<void> = Promise.resolve();
  #queuedWrites = 0;
  #closed = false;
  public constructor(
    private readonly write: (bytes: Uint8Array) => Promise<void>,
    private readonly handlers: Readonly<Record<string, AppBridgeHandler>>,
    private readonly onFailure: () => void = () => {},
  ) {}

  public async call(methodName: string, value: unknown): Promise<unknown> {
    if (this.#closed) throw new AppBridgeError("unavailable");
    if (this.#pending.size >= APP_BRIDGE_MAX_PENDING) throw new AppBridgeError("busy");
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    void response.catch(() => {});
    try { await this.#send({ version: 1, kind: "request", id, method: methodName, value }); }
    catch (error) { this.close(); throw error; }
    return response;
  }

  public push(bytes: Uint8Array): void {
    if (this.#closed) throw new AppBridgeError("unavailable");
    try {
      // Bound each incomplete frame, including when a chunk contains many complete frames.
      let start = 0;
      for (let index = 0; index < bytes.byteLength; index++) {
        if (bytes[index] !== 10) continue;
        if (this.#buffer.length + index - start > APP_BRIDGE_MAX_FRAME_BYTES) throw new Error();
        const line = Buffer.concat([this.#buffer, bytes.subarray(start, index)]);
        this.#buffer = Buffer.alloc(0);
        const frame = appBridgeFrameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        this.#receive(frame);
        start = index + 1;
      }
      if (this.#buffer.length + bytes.byteLength - start > APP_BRIDGE_MAX_FRAME_BYTES) throw new Error();
      this.#buffer = Buffer.concat([this.#buffer, bytes.subarray(start)]);
    } catch {
      this.close();
      throw new AppBridgeError("invalid_request");
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) pending.reject(new AppBridgeError("unavailable"));
    this.#pending.clear();
    this.onFailure();
  }

  #receive(frame: AppBridgeFrame): void {
    if (frame.kind !== "request") {
      const pending = this.#pending.get(frame.id);
      if (!pending) throw new Error("unsolicited or duplicate response");
      this.#pending.delete(frame.id);
      if (frame.kind === "failure") pending.reject(new AppBridgeError(frame.code));
      else pending.resolve(frame.value);
      return;
    }
    if (this.#incoming.size >= APP_BRIDGE_MAX_PENDING || this.#incoming.has(frame.id)) throw new Error();
    this.#incoming.add(frame.id);
    const handler = Object.hasOwn(this.handlers, frame.method) ? this.handlers[frame.method] : undefined;
    void Promise.resolve().then(() => {
      if (!handler) throw new AppBridgeError("invalid_request");
      return handler(frame.value);
    }).then(
      value => this.#send({ version: 1, kind: "response", id: frame.id, value }),
      error => this.#send({ version: 1, kind: "failure", id: frame.id,
        code: error instanceof AppBridgeError ? error.code : "unavailable" }),
    ).catch(() => this.close()).finally(() => this.#incoming.delete(frame.id));
  }

  #send(frame: AppBridgeFrame): Promise<void> {
    if (this.#closed) return Promise.reject(new AppBridgeError("unavailable"));
    const bytes = Buffer.from(`${JSON.stringify(appBridgeFrameSchema.parse(frame))}\n`);
    if (bytes.length > APP_BRIDGE_MAX_FRAME_BYTES + 1 || this.#queuedWrites >= APP_BRIDGE_MAX_PENDING * 2) {
      return Promise.reject(new AppBridgeError("invalid_request"));
    }
    this.#queuedWrites++;
    const sent = this.#writeTail.then(async () => {
      if (this.#closed) throw new AppBridgeError("unavailable");
      await this.write(bytes);
    }).finally(() => { bytes.fill(0); this.#queuedWrites--; });
    this.#writeTail = sent.catch(() => this.close());
    return sent;
  }
}
