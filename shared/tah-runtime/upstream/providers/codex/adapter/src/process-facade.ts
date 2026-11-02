import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_JSON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;
const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_EVENT_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 2_000;
const KILL_GRACE_MS = 500;

export interface CodexAppServerNotificationV1 {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerRequestV1 {
  readonly kind: "server_request";
  readonly method: string;
  readonly params: unknown;
}

export type CodexAppServerInboundV1 =
  | CodexAppServerNotificationV1
  | CodexAppServerRequestV1;

export interface CodexAppServerExitReceiptV1 {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

export interface CodexAppServerConnectionV1 {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  events(): AsyncIterable<CodexAppServerInboundV1>;
  close(): Promise<CodexAppServerExitReceiptV1>;
}

export interface CodexAppServerStartV1 {
  readonly executablePath: string;
  readonly controllerHome: string;
  readonly workspaceRoot: string;
}

export interface CodexAppServerFacadeV1 {
  start(request: CodexAppServerStartV1): Promise<CodexAppServerConnectionV1>;
}

export interface CodexChildLaunchSpecV1 {
  readonly executablePath: string;
  readonly arguments: readonly ["app-server", "--stdio", "--strict-config"];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CodexChildProcessPortV1 {
  readonly stdout: AsyncIterable<Uint8Array>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  terminate(): void;
  kill(): void;
  waitForExit(): Promise<CodexAppServerExitReceiptV1>;
}

export interface CodexChildLauncherPortV1 {
  start(specification: CodexChildLaunchSpecV1): Promise<CodexChildProcessPortV1>;
}

/** Exact pinned app-server stdio transport used directly by the Provider Adapter. */
export class CodexStdioAppServerFacadeV1 implements CodexAppServerFacadeV1 {
  readonly #launcher: CodexChildLauncherPortV1;

  public constructor(launcher: CodexChildLauncherPortV1 = new NodeCodexChildLauncherV1()) {
    this.#launcher = launcher;
  }

  public async start(request: CodexAppServerStartV1): Promise<CodexAppServerConnectionV1> {
    assertAbsolutePath(request.executablePath, "executable");
    assertAbsolutePath(request.controllerHome, "controller home");
    assertAbsolutePath(request.workspaceRoot, "workspace");
    const environment: Record<string, string> = {
      CODEX_HOME: request.controllerHome,
      HOME: request.controllerHome,
      SHELL: "/bin/bash",
      PATH: [
        "/opt/alma/provider/codex/codex-path",
        "/opt/alma/provider/codex/codex-resources",
        "/usr/bin",
        "/bin",
      ].join(":"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    const child = await this.#launcher.start(Object.freeze({
      executablePath: request.executablePath,
      arguments: Object.freeze(["app-server", "--stdio", "--strict-config"] as const),
      cwd: request.controllerHome,
      environment: Object.freeze(environment),
    }));
    return new CodexStdioConnectionV1(child);
  }
}

export class CodexAppServerRPCErrorV1 extends Error {
  public constructor(
    public readonly code: number,
    public readonly data: unknown,
    public readonly requestMethod?: string,
    public readonly diagnosticWords?: string,
  ) {
    super("Codex app-server rejected a request");
    this.name = "CodexAppServerRPCErrorV1";
  }
}

export class CodexAppServerTransportErrorV1 extends Error {
  public constructor(public readonly code: string) {
    super("Codex app-server transport failed");
    this.name = "CodexAppServerTransportErrorV1";
  }
}

class CodexStdioConnectionV1 implements CodexAppServerConnectionV1 {
  readonly #child: CodexChildProcessPortV1;
  readonly #events = new AsyncQueueV1<CodexAppServerInboundV1>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #pump: Promise<void>;
  #nextRequestID = 1;
  #writeChain: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<CodexAppServerExitReceiptV1> | undefined;
  #fatal: unknown;

  public constructor(child: CodexChildProcessPortV1) {
    this.#child = child;
    this.#pump = this.#readOutput();
    void this.#pump.catch(() => {});
  }

  public request(method: string, params: unknown): Promise<unknown> {
    assertMethod(method);
    if (this.#closed || this.#fatal !== undefined) {
      return Promise.reject(new CodexAppServerTransportErrorV1("connection_closed"));
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new CodexAppServerTransportErrorV1("too_many_requests"));
    }
    const id = this.#nextRequestID++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<unknown>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexAppServerTransportErrorV1("request_timeout"));
      }, REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      this.#pending.set(id, { resolve, reject, timeout, method });
    });
    void this.#write({ id, method, params }).catch((error) => {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    return response;
  }

  public notify(method: string, params?: unknown): Promise<void> {
    assertMethod(method);
    return this.#write(params === undefined ? { method } : { method, params });
  }

  public events(): AsyncIterable<CodexAppServerInboundV1> {
    return this.#events;
  }

  public close(): Promise<CodexAppServerExitReceiptV1> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<CodexAppServerExitReceiptV1> {
    try {
      await this.#child.closeStdin();
    } catch {
      this.#child.terminate();
    }
    let receipt = await waitWithTimeout(this.#child.waitForExit(), EXIT_GRACE_MS);
    if (receipt === undefined) {
      this.#child.terminate();
      receipt = await waitWithTimeout(this.#child.waitForExit(), KILL_GRACE_MS);
    }
    if (receipt === undefined) {
      this.#child.kill();
      receipt = await this.#child.waitForExit();
    }
    await this.#pump.catch(() => {});
    if (this.#fatal !== undefined || receipt.code !== 0) {
      throw new CodexAppServerTransportErrorV1("unclean_exit");
    }
    return receipt;
  }

  async #write(value: unknown): Promise<void> {
    if (this.#closed) throw new CodexAppServerTransportErrorV1("connection_closed");
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (encoded.byteLength > MAX_JSON_LINE_BYTES) {
      throw new CodexAppServerTransportErrorV1("outbound_frame_too_large");
    }
    const write = this.#writeChain.then(async () => {
      try {
        await this.#child.writeStdin(encoded);
      } finally {
        encoded.fill(0);
      }
    });
    this.#writeChain = write.catch(() => {});
    await write;
  }

  async #readOutput(): Promise<void> {
    let buffered = Buffer.alloc(0);
    try {
      for await (const chunkValue of this.#child.stdout) {
        const chunk = Buffer.from(chunkValue);
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const newline = buffered.indexOf(0x0a);
          if (newline < 0) break;
          if (newline > MAX_JSON_LINE_BYTES) {
            throw new CodexAppServerTransportErrorV1("inbound_frame_too_large");
          }
          const line = buffered.subarray(0, newline);
          buffered = buffered.subarray(newline + 1);
          if (line.byteLength === 0) continue;
          this.#acceptLine(line);
        }
        if (buffered.byteLength > MAX_JSON_LINE_BYTES) {
          throw new CodexAppServerTransportErrorV1("inbound_frame_too_large");
        }
      }
      if (buffered.byteLength !== 0) {
        throw new CodexAppServerTransportErrorV1("truncated_frame");
      }
      const receipt = await this.#child.waitForExit();
      if (receipt.code !== 0 && !this.#closed) {
        throw new CodexAppServerTransportErrorV1("unexpected_exit");
      }
      this.#events.end();
      this.#rejectPending(new CodexAppServerTransportErrorV1("connection_closed"));
    } catch (error) {
      this.#fatal = error;
      this.#events.fail(error);
      this.#rejectPending(error);
      this.#child.terminate();
      throw error;
    }
  }

  #acceptLine(line: Uint8Array): void {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      throw new CodexAppServerTransportErrorV1("invalid_json");
    }
    const record = readRecord(value);
    if (record === undefined) throw new CodexAppServerTransportErrorV1("invalid_message");
    const id = readRequestID(record.id);
    if (Object.hasOwn(record, "id") && id === undefined) {
      throw new CodexAppServerTransportErrorV1("invalid_message");
    }
    if (id !== undefined && Object.hasOwn(record, "result")) {
      this.#resolveResponse(id, record.result);
      return;
    }
    if (id !== undefined && Object.hasOwn(record, "error")) {
      const error = readRecord(record.error);
      if (error === undefined || !Number.isSafeInteger(error.code)) {
        throw new CodexAppServerTransportErrorV1("invalid_error_response");
      }
      this.#rejectResponse(
        id,
        new CodexAppServerRPCErrorV1(error.code as number, error.data,
          typeof id === "number" ? this.#pending.get(id)?.method : undefined,
          rpcDiagnosticWords(error.message)),
      );
      return;
    }
    const method = typeof record.method === "string" ? record.method : undefined;
    if (method === undefined || method.length === 0) {
      throw new CodexAppServerTransportErrorV1("invalid_message");
    }
    if (id !== undefined) {
      void this.#write({
        id,
        error: {
          code: -32601,
          message: "ALMA does not permit server-initiated requests for this attempt",
        },
      }).catch(() => {});
      this.#events.push({ kind: "server_request", method, params: record.params });
      return;
    }
    this.#events.push({ kind: "notification", method, params: record.params });
  }

  #resolveResponse(id: number | string, result: unknown): void {
    if (typeof id !== "number") throw new CodexAppServerTransportErrorV1("unknown_response");
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new CodexAppServerTransportErrorV1("unknown_response");
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  #rejectResponse(id: number | string, error: unknown): void {
    if (typeof id !== "number") throw new CodexAppServerTransportErrorV1("unknown_response");
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new CodexAppServerTransportErrorV1("unknown_response");
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** Closed diagnostic vocabulary only; never expose native error text or use it for admission. */
function rpcDiagnosticWords(value: unknown): string {
  if (typeof value !== "string") return "unspecified";
  return (value.toLowerCase().match(/\b(?:unknown|missing|profile|permission|permissions|legacy|sandbox|read|write|policy|file|root|unsupported|default|field|unauthorized|failed|credential|authentication|not|found|cannot|compute|projection|relative|absolute|system|path|configuration)\b/gu) ?? [])
    .slice(0, 24).join(" ") || "unspecified";
}

class AsyncQueueV1<T> implements AsyncIterable<T> {
  readonly #values: Array<{ readonly value: T; readonly bytes: number }> = [];
  readonly #waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  #ended = false;
  #failure: unknown;
  #iterated = false;
  #queuedBytes = 0;

  public push(value: T): void {
    if (this.#ended || this.#failure !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (
      this.#values.length >= MAX_QUEUED_EVENTS
      || this.#queuedBytes + bytes > MAX_QUEUED_EVENT_BYTES
    ) {
      const error = new CodexAppServerTransportErrorV1("event_queue_overflow");
      this.fail(error);
      throw error;
    }
    this.#values.push({ value, bytes });
    this.#queuedBytes += bytes;
  }

  public end(): void {
    if (this.#ended || this.#failure !== undefined) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  public fail(error: unknown): void {
    if (this.#ended || this.#failure !== undefined) return;
    this.#failure = error;
    this.#values.splice(0);
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new CodexAppServerTransportErrorV1("events_already_consumed");
    this.#iterated = true;
    return {
      next: () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#queuedBytes -= queued.bytes;
          return Promise.resolve({ value: queued.value, done: false });
        }
        if (this.#failure !== undefined) return Promise.reject(this.#failure);
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class NodeCodexChildLauncherV1 implements CodexChildLauncherPortV1 {
  public start(specification: CodexChildLaunchSpecV1): Promise<CodexChildProcessPortV1> {
    const child = spawn(
      specification.executablePath,
      [...specification.arguments],
      {
        cwd: specification.cwd,
        env: { ...specification.environment },
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stderr.on("data", () => {});
    return Promise.resolve(new NodeCodexChildProcessV1(child));
  }
}

class NodeCodexChildProcessV1 implements CodexChildProcessPortV1 {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<CodexAppServerExitReceiptV1>;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.stdout = child.stdout;
    this.#exit = new Promise((resolve, reject) => {
      child.once("error", () => reject(new CodexAppServerTransportErrorV1("spawn_failed")));
      child.once("exit", (code, signal) => resolve({ code: code ?? -1, signal }));
    });
    void this.#exit.catch(() => {});
  }

  public writeStdin(bytes: Uint8Array): Promise<void> {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) {
      return Promise.reject(new CodexAppServerTransportErrorV1("stdin_closed"));
    }
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(bytes, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(new CodexAppServerTransportErrorV1("stdin_write_failed"));
      });
    });
  }

  public closeStdin(): Promise<void> {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return Promise.resolve();
    return new Promise((resolve) => this.#child.stdin.end(resolve));
  }

  public terminate(): void {
    this.#child.kill("SIGTERM");
  }

  public kill(): void {
    this.#child.kill("SIGKILL");
  }

  public waitForExit(): Promise<CodexAppServerExitReceiptV1> {
    return this.#exit;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRequestID(value: unknown): number | string | undefined {
  return Number.isSafeInteger(value) || typeof value === "string"
    ? value as number | string
    : undefined;
}

function assertMethod(value: string): void {
  if (value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Codex app-server method is invalid");
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith("/") || value === "/" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Codex ${label} path is invalid`);
  }
}


async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
