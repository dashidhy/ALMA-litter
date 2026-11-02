import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import type {
  DedicatedProviderChildExitV1,
  DedicatedProviderChildV1,
  DedicatedProviderSpawnPortV1,
} from "./ports.js";

const MAXIMUM_ENVIRONMENT_ENTRIES = 64;
const MAXIMUM_ENVIRONMENT_VALUE_UTF8_BYTES = 4 * 1024;
const MAXIMUM_ENVIRONMENT_UTF8_BYTES = 32 * 1024;
export const DEDICATED_PROVIDER_UID = 1000;
export const DEDICATED_PROVIDER_GID = 1000;

export interface DedicatedProviderNodeSpawnOptionsV1 {
  readonly setprivExecutable: string;
  readonly nodeExecutable: string;
  readonly bootstrapEntry: string;
  readonly providerModule: string;
  readonly cwd: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly launcher?: DedicatedProviderNodeLauncherV1;
}

export interface DedicatedProviderNodeLaunchRequestV1 {
  readonly executable: string;
  readonly arguments: readonly [
    string, string, string, string, string, string, string, string, string, string, string,
  ];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly detached: false;
  readonly stdio: readonly ["pipe", "pipe", "ignore", "pipe"];
}

export interface DedicatedProviderNodeLaunchedProcessV1 {
  readonly pid: number;
  readonly controlInput: Writable;
  readonly controlOutput: Readable;
  readonly credentialInput: Writable;
  readonly exit: Promise<DedicatedProviderChildExitV1>;
  terminate(signal: "SIGTERM"): void | Promise<void>;
}

export type DedicatedProviderNodeLauncherV1 = (
  request: DedicatedProviderNodeLaunchRequestV1,
) => Promise<DedicatedProviderNodeLaunchedProcessV1>;

export type DedicatedProviderNodeSpawnErrorCode =
  | "invalid_configuration"
  | "invalid_state"
  | "spawn_failed"
  | "stdio_unavailable"
  | "write_failed"
  | "exit_timeout"
  | "termination_failed";

/**
 * Generic, one-shot Node bootstrap launcher. It knows only fixed appliance
 * paths and never imports the selected Provider module into the supervisor.
 */
export class DedicatedProviderNodeSpawnPortV1 implements DedicatedProviderSpawnPortV1 {
  readonly #request: DedicatedProviderNodeLaunchRequestV1;
  readonly #launcher: DedicatedProviderNodeLauncherV1;
  #spawned = false;

  public constructor(options: DedicatedProviderNodeSpawnOptionsV1) {
    const setprivExecutable = canonicalRegularFile(
      options.setprivExecutable,
      "setpriv executable",
      true,
    );
    const nodeExecutable = canonicalRegularFile(
      options.nodeExecutable,
      "Node executable",
      true,
    );
    const bootstrapEntry = canonicalRegularFile(
      options.bootstrapEntry,
      "bootstrap entry",
      false,
    );
    const providerModule = canonicalRegularFile(
      options.providerModule,
      "Provider module",
      false,
    );
    if (bootstrapEntry === providerModule) invalidConfiguration("Bootstrap and Provider must differ");
    const cwd = canonicalDirectory(options.cwd);
    const uid = fixedUnprivilegedIdentity(
      options.uid,
      DEDICATED_PROVIDER_UID,
      "uid",
    );
    const gid = fixedUnprivilegedIdentity(
      options.gid,
      DEDICATED_PROVIDER_GID,
      "gid",
    );
    const environment = closedEnvironment(options.environment);

    this.#request = Object.freeze({
      executable: setprivExecutable,
      arguments: Object.freeze([
        `--reuid=${uid}`,
        `--regid=${gid}`,
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        nodeExecutable,
        bootstrapEntry,
        providerModule,
      ]) as readonly [
        string, string, string, string, string, string, string, string, string, string, string,
      ],
      cwd,
      environment,
      shell: false,
      detached: false,
      stdio: Object.freeze(["pipe", "pipe", "ignore", "pipe"]) as readonly [
        "pipe",
        "pipe",
        "ignore",
        "pipe",
      ],
    });
    this.#launcher = options.launcher ?? launchSystemNodeProcess;
  }

  public async spawnBootstrap(): Promise<DedicatedProviderChildV1> {
    if (this.#spawned) {
      throw new DedicatedProviderNodeSpawnError(
        "invalid_state",
        "Dedicated Provider Node spawn port is one-shot",
      );
    }
    this.#spawned = true;
    let process: DedicatedProviderNodeLaunchedProcessV1;
    try {
      process = await this.#launcher(this.#request);
    } catch (cause) {
      throw new DedicatedProviderNodeSpawnError(
        "spawn_failed",
        "Trusted Provider bootstrap could not be spawned",
        { cause },
      );
    }
    try {
      validateLaunchedProcess(process);
    } catch (cause) {
      try {
        await process.terminate?.("SIGTERM");
      } catch {
        // The invalid launcher result remains a launch failure. Its launcher
        // contract owns cleanup if it did not provide a usable terminator.
      }
      throw cause;
    }
    return new DedicatedProviderNodeChildV1(process);
  }
}

class DedicatedProviderNodeChildV1 implements DedicatedProviderChildV1 {
  public readonly pid: number;
  public readonly output: AsyncIterable<Uint8Array>;
  readonly #process: DedicatedProviderNodeLaunchedProcessV1;
  #controlTail: Promise<void> = Promise.resolve();
  #credentialTail: Promise<void> = Promise.resolve();
  #credentialClose: Promise<void> | undefined;
  #revoked = false;
  #exitObserved = false;

  public constructor(process: DedicatedProviderNodeLaunchedProcessV1) {
    this.#process = process;
    this.pid = process.pid;
    this.output = this.#readOutput();
    void process.exit.then(() => {
      this.#exitObserved = true;
    }, () => {
      this.#exitObserved = true;
    });
  }

  public writeControl(bytes: Uint8Array): Promise<void> {
    return this.#enqueueWrite("control", this.#process.controlInput, bytes);
  }

  public writeCredential(bytes: Uint8Array): Promise<void> {
    if (this.#credentialClose !== undefined) {
      return Promise.reject(new DedicatedProviderNodeSpawnError(
        "write_failed",
        "Credential input is already closed",
      ));
    }
    return this.#enqueueWrite("credential", this.#process.credentialInput, bytes);
  }

  public closeCredential(): Promise<void> {
    if (this.#credentialClose !== undefined) return this.#credentialClose;
    if (this.#revoked || this.#process.credentialInput.destroyed) {
      this.#credentialClose = Promise.resolve();
      return this.#credentialClose;
    }
    this.#credentialClose = this.#credentialTail.then(
      () => endWritable(this.#process.credentialInput, "credential"),
    );
    return this.#credentialClose;
  }

  public revokeInput(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#process.controlInput.destroy();
    this.#process.credentialInput.destroy();
  }

  public releaseOutput(): void {
    this.#process.controlOutput.destroy();
  }

  public async terminate(signal: "SIGTERM"): Promise<void> {
    if (this.#exitObserved) return;
    try {
      await this.#process.terminate(signal);
    } catch (cause) {
      throw new DedicatedProviderNodeSpawnError(
        "termination_failed",
        "Provider bootstrap could not be terminated",
        { cause },
      );
    }
  }

  public waitForExit(timeoutMilliseconds: number): Promise<DedicatedProviderChildExitV1> {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      return Promise.reject(new DedicatedProviderNodeSpawnError(
        "invalid_configuration",
        "Exit timeout must be a positive safe integer",
      ));
    }
    return withExitTimeout(this.#process.exit, timeoutMilliseconds);
  }

  #enqueueWrite(
    channel: "control" | "credential",
    stream: Writable,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return Promise.reject(new DedicatedProviderNodeSpawnError(
        "write_failed",
        `${channel} write must contain bytes`,
      ));
    }
    if (this.#revoked || stream.destroyed || stream.writableEnded) {
      return Promise.reject(new DedicatedProviderNodeSpawnError(
        "write_failed",
        `${channel} input is unavailable`,
      ));
    }
    const copied = Buffer.from(bytes);
    const previous = channel === "control" ? this.#controlTail : this.#credentialTail;
    const operation = previous
      .then(() => {
        if (this.#revoked || stream.destroyed || stream.writableEnded) {
          throw new DedicatedProviderNodeSpawnError(
            "write_failed",
            `${channel} input is unavailable`,
          );
        }
        return writeWritable(stream, copied, channel);
      })
      .finally(() => copied.fill(0));
    if (channel === "control") this.#controlTail = operation.catch(() => {});
    else this.#credentialTail = operation.catch(() => {});
    return operation;
  }

  async *#readOutput(): AsyncGenerator<Uint8Array> {
    for await (const chunk of this.#process.controlOutput) {
      if (!(chunk instanceof Uint8Array)) {
        throw new DedicatedProviderNodeSpawnError(
          "stdio_unavailable",
          "Provider bootstrap changed control output to a text encoding",
        );
      }
      const copied = Buffer.from(chunk);
      try {
        yield new Uint8Array(copied.buffer, copied.byteOffset, copied.byteLength);
      } finally {
        copied.fill(0);
      }
    }
  }
}

async function launchSystemNodeProcess(
  request: DedicatedProviderNodeLaunchRequestV1,
): Promise<DedicatedProviderNodeLaunchedProcessV1> {
  const child = spawn(
    request.executable,
    [...request.arguments],
    {
      cwd: request.cwd,
      env: { ...request.environment },
      shell: request.shell,
      detached: request.detached,
      stdio: [...request.stdio],
    },
  );
  // Keep post-spawn process errors observational; `close` below is the
  // authoritative reaping receipt. The one-shot listener still rejects an
  // initial spawn failure.
  child.on("error", () => {});
  const exit = new Promise<DedicatedProviderChildExitV1>((resolveExit) => {
    child.once("close", (exitCode, signal) => {
      resolveExit(Object.freeze({
        exitCode,
        signal,
        reaped: true,
      }));
    });
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolveSpawn();
    };
    const onError = (cause: Error): void => {
      child.off("spawn", onSpawn);
      rejectSpawn(cause);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  const credentialInput = child.stdio[3];
  if (
    child.pid === undefined
    || child.stdin === null
    || child.stdout === null
    || credentialInput === null
    || typeof (credentialInput as Writable).write !== "function"
  ) {
    child.kill("SIGTERM");
    throw new DedicatedProviderNodeSpawnError(
      "stdio_unavailable",
      "Provider bootstrap did not expose its closed pipe topology",
    );
  }
  return Object.freeze({
    pid: child.pid,
    controlInput: child.stdin,
    controlOutput: child.stdout,
    credentialInput: credentialInput as Writable,
    exit,
    terminate: (signal: "SIGTERM") => {
      if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
        throw new Error("kill was rejected");
      }
    },
  });
}

function canonicalRegularFile(value: string, label: string, executable: boolean): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    invalidConfiguration(`${label} path is invalid`);
  }
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(value);
    canonical = realpathSync(value);
  } catch (cause) {
    throw new DedicatedProviderNodeSpawnError(
      "invalid_configuration",
      `${label} is unavailable`,
      { cause },
    );
  }
  if (
    canonical !== value
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || (executable && (metadata.mode & 0o111) === 0)
  ) {
    invalidConfiguration(`${label} is not a canonical regular file`);
  }
  return canonical;
}

function canonicalDirectory(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    invalidConfiguration("Working directory path is invalid");
  }
  let metadata;
  let canonical;
  try {
    metadata = lstatSync(value);
    canonical = realpathSync(value);
  } catch (cause) {
    throw new DedicatedProviderNodeSpawnError(
      "invalid_configuration",
      "Working directory is unavailable",
      { cause },
    );
  }
  if (canonical !== value || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    invalidConfiguration("Working directory is not a canonical directory");
  }
  return canonical;
}

function fixedUnprivilegedIdentity(value: number, expected: number, label: string): number {
  if (value !== expected) {
    invalidConfiguration(`Provider ${label} does not match the fixed appliance identity`);
  }
  return value;
}

function closedEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidConfiguration("Provider environment must be an explicit record");
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const keys = Object.keys(value).sort();
  if (keys.length > MAXIMUM_ENVIRONMENT_ENTRIES) {
    invalidConfiguration("Provider environment exceeds its entry bound");
  }
  let totalBytes = 0;
  for (const key of keys) {
    const entry = value[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
      || forbiddenEnvironmentName(key)
      || typeof entry !== "string"
      || entry.includes("\0")) {
      invalidConfiguration("Provider environment contains a forbidden entry");
    }
    const entryBytes = Buffer.byteLength(entry, "utf8");
    totalBytes += Buffer.byteLength(key, "utf8") + entryBytes;
    if (entryBytes > MAXIMUM_ENVIRONMENT_VALUE_UTF8_BYTES
      || !Number.isSafeInteger(totalBytes)
      || totalBytes > MAXIMUM_ENVIRONMENT_UTF8_BYTES) {
      invalidConfiguration("Provider environment exceeds its byte bound");
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function forbiddenEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized === "NODE_OPTIONS"
    || normalized === "NODE_PATH"
    || normalized.startsWith("LD_")
    || normalized.startsWith("DYLD_")
    || /(?:^|_)(?:ACCESS|API_?KEY|AUTH(?:ORIZATION)?|BEARER|CAPABILITY|COOKIE|CREDENTIALS?|KEYCHAIN|LEASE|OAUTH|PASS(?:WORD|WD)?|PRIVATE|PROXY|SECRET|SESSION|TOKEN)(?:_|$)/u
      .test(normalized)
    || /(?:^|_)CGROUP(?:_|$)/u.test(normalized);
}

function validateLaunchedProcess(value: DedicatedProviderNodeLaunchedProcessV1): void {
  if (
    value === null
    || typeof value !== "object"
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 1
    || value.controlInput === null
    || typeof value.controlInput.write !== "function"
    || value.controlOutput === null
    || typeof value.controlOutput[Symbol.asyncIterator] !== "function"
    || value.credentialInput === null
    || typeof value.credentialInput.write !== "function"
    || value.exit === null
    || typeof value.exit.then !== "function"
    || typeof value.terminate !== "function"
  ) {
    throw new DedicatedProviderNodeSpawnError(
      "stdio_unavailable",
      "Provider launcher returned an invalid closed pipe topology",
    );
  }
}

function writeWritable(stream: Writable, bytes: Buffer, channel: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    const onError = (cause: Error): void => {
      stream.off("error", onError);
      rejectWrite(new DedicatedProviderNodeSpawnError(
        "write_failed",
        `${channel} pipe write failed`,
        { cause },
      ));
    };
    stream.once("error", onError);
    stream.write(bytes, (cause?: Error | null) => {
      stream.off("error", onError);
      if (cause) {
        rejectWrite(new DedicatedProviderNodeSpawnError(
          "write_failed",
          `${channel} pipe write failed`,
          { cause },
        ));
      } else {
        resolveWrite();
      }
    });
  });
}

function endWritable(stream: Writable, channel: string): Promise<void> {
  return new Promise((resolveEnd, rejectEnd) => {
    const onError = (cause: Error): void => {
      stream.off("error", onError);
      rejectEnd(new DedicatedProviderNodeSpawnError(
        "write_failed",
        `${channel} pipe close failed`,
        { cause },
      ));
    };
    stream.once("error", onError);
    stream.end(() => {
      stream.off("error", onError);
      resolveEnd();
    });
  });
}

function withExitTimeout(
  exit: Promise<DedicatedProviderChildExitV1>,
  timeoutMilliseconds: number,
): Promise<DedicatedProviderChildExitV1> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DedicatedProviderNodeSpawnError(
      "exit_timeout",
      "Provider bootstrap was not reaped before its deadline",
    )), timeoutMilliseconds);
    timer.unref();
  });
  return Promise.race([exit, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function invalidConfiguration(message: string): never {
  throw new DedicatedProviderNodeSpawnError("invalid_configuration", message);
}

export class DedicatedProviderNodeSpawnError extends Error {
  public constructor(
    public readonly code: DedicatedProviderNodeSpawnErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DedicatedProviderNodeSpawnError";
  }
}
