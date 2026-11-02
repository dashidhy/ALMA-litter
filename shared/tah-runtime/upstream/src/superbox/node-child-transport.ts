import { createHash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type {
  SuperBoxDuplexChildTransportV1,
  SuperBoxProcessExitReceiptV1,
} from "./process-client.js";

export interface TrustedSuperBoxRegularFileV1 {
  readonly absolutePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SuperBoxSealedManifestIdentityV1 {
  readonly providerID: string;
  readonly applianceID: string;
  readonly attemptQualification: "qualified" | "unverified" | "no_go";
}

export interface LaunchSuperBoxNodeChildTransportV1 {
  readonly hostExecutable: TrustedSuperBoxRegularFileV1;
  readonly sealedManifest: TrustedSuperBoxRegularFileV1;
  readonly maximumStderrBytes?: number;
  readonly gracefulDestroyMilliseconds?: number;
  readonly forcedDestroyMilliseconds?: number;
}

export type NodeSuperBoxChildTransportErrorCode =
  | "invalid_configuration"
  | "unsafe_file"
  | "spawn_failed"
  | "bootstrap_failed"
  | "stdin_unavailable"
  | "write_failed"
  | "input_close_before_exit"
  | "destroy_failed";

export class NodeSuperBoxChildTransportError extends Error {
  public constructor(
    public readonly code: NodeSuperBoxChildTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeSuperBoxChildTransportError";
  }
}

const MAXIMUM_HOST_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_STDERR_BYTES = 64 * 1024;
const DEFAULT_GRACEFUL_DESTROY_MILLISECONDS = 15_000;
const DEFAULT_FORCED_DESTROY_MILLISECONDS = 5_000;
const SUPERBOX_BOOTSTRAP_MAGIC = Buffer.from("ALMASB03", "ascii");
const SUPERBOX_BOOTSTRAP_BYTES = 40;
const FIXED_CHILD_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

/** Reads only routing identity from an already digest-pinned sealed manifest. */
export async function inspectSealedSuperBoxManifestIdentityV1(
  declaration: TrustedSuperBoxRegularFileV1,
): Promise<SuperBoxSealedManifestIdentityV1> {
  validateTrustedFileDeclaration(declaration);
  const trusted = await validateTrustedRegularFile(
    declaration,
    MAXIMUM_MANIFEST_BYTES,
    false,
  );
  const bytes = await readFile(trusted.absolutePath);
  try {
    if (bytes.byteLength !== declaration.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== declaration.sha256) {
      throw new NodeSuperBoxChildTransportError(
        "unsafe_file",
        "The sealed SuperBox manifest changed during identity inspection",
      );
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest root is invalid");
    }
    const providerID = Reflect.get(value, "providerID");
    const applianceID = Reflect.get(value, "applianceID");
    const attemptQualification = Reflect.get(value, "attemptQualification");
    if (typeof providerID !== "string"
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(providerID)
      || typeof applianceID !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(applianceID)
      || (attemptQualification !== "qualified"
        && attemptQualification !== "unverified"
        && attemptQualification !== "no_go")) {
      throw new Error("manifest identity is invalid");
    }
    return Object.freeze({ providerID, applianceID, attemptQualification });
  } catch (cause) {
    if (cause instanceof NodeSuperBoxChildTransportError) throw cause;
    throw new NodeSuperBoxChildTransportError(
      "unsafe_file",
      "The sealed SuperBox manifest has no valid routing identity",
      { cause },
    );
  } finally {
    bytes.fill(0);
  }
}

export async function launchSuperBoxNodeChildTransportV1(
  options: LaunchSuperBoxNodeChildTransportV1,
): Promise<NodeSuperBoxChildTransportV1> {
  const declaredConfiguration = validateConfiguration(options);
  const [hostExecutable, sealedManifest] = await Promise.all([
    validateTrustedRegularFile(
      declaredConfiguration.hostExecutable,
      MAXIMUM_HOST_EXECUTABLE_BYTES,
      true,
    ),
    validateTrustedRegularFile(
      declaredConfiguration.sealedManifest,
      MAXIMUM_MANIFEST_BYTES,
      false,
    ),
  ]);
  const configuration: ValidatedConfiguration = Object.freeze({
    ...declaredConfiguration,
    hostExecutable,
    sealedManifest,
  });

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      configuration.hostExecutable.absolutePath,
      [configuration.sealedManifest.absolutePath],
      {
        cwd: "/",
        detached: false,
        env: FIXED_CHILD_ENVIRONMENT,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (cause) {
    throw new NodeSuperBoxChildTransportError(
      "spawn_failed",
      "Could not spawn the trusted SuperBox Host executable",
      { cause },
    );
  }
  const transport = new NodeSuperBoxChildTransportV1(child, configuration);
  try {
    await transport.waitUntilBootstrapped();
  } catch (cause) {
    try {
      await transport.destroy();
    } catch (cleanupCause) {
      throw new NodeSuperBoxChildTransportError(
        "destroy_failed",
        "SuperBox bootstrap failed and child destruction was not confirmed",
        { cause: new AggregateError([cause, cleanupCause]) },
      );
    }
    throw cause;
  }
  return transport;
}

interface ValidatedConfiguration {
  readonly hostExecutable: TrustedSuperBoxRegularFileV1;
  readonly sealedManifest: TrustedSuperBoxRegularFileV1;
  readonly maximumStderrBytes: number;
  readonly gracefulDestroyMilliseconds: number;
  readonly forcedDestroyMilliseconds: number;
}

/**
 * Node lifecycle wrapper below the semantic SuperBox process client.
 *
 * It never decodes frames or receives Provider identity. Child `close` is the
 * only source of a destroyed receipt; stdout EOF alone is never sufficient.
 */
export class NodeSuperBoxChildTransportV1 implements SuperBoxDuplexChildTransportV1 {
  public readonly stdout: AsyncIterable<Uint8Array>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #configuration: ValidatedConfiguration;
  readonly #spawned: Promise<void>;
  readonly #bootstrapped: Promise<void>;
  readonly #exit: Promise<SuperBoxProcessExitReceiptV1>;
  #writeTail: Promise<void>;
  #destroyPromise: Promise<void> | undefined;
  #didSpawn = false;
  #didClose = false;
  #inputClosed = false;
  #stderrBytes = 0;
  #stderrTruncated = false;

  public constructor(
    child: ChildProcessWithoutNullStreams,
    configuration: ValidatedConfiguration,
  ) {
    this.#child = child;
    this.#configuration = configuration;
    this.stdout = this.#stdoutBytes();
    this.#spawned = new Promise((resolveSpawn, rejectSpawn) => {
      const onSpawn = (): void => {
        this.#didSpawn = true;
        child.off("error", onInitialError);
        resolveSpawn();
      };
      const onInitialError = (cause: Error): void => {
        child.off("spawn", onSpawn);
        rejectSpawn(new NodeSuperBoxChildTransportError(
          "spawn_failed",
          "The trusted SuperBox Host executable did not spawn",
          { cause },
        ));
      };
      child.once("spawn", onSpawn);
      child.once("error", onInitialError);
    });
    this.#exit = new Promise((resolveExit) => {
      child.once("close", (exitCode, signal) => {
        this.#didClose = true;
        // A crashed/killed helper cannot attest whole-VM destruction. Only
        // its documented 0/1 exits, or failure to spawn at all, can do so.
        const destroyed = !this.#didSpawn || (signal === null && (exitCode === 0 || exitCode === 1));
        resolveExit(Object.freeze({ exitCode, destroyed }));
      });
    });
    child.stderr.on("data", (chunk: Buffer) => this.#observeStderr(chunk));
    child.stderr.resume();
    // Error after the successful spawn is observational. The authoritative
    // outcome remains the final close receipt or the bounded destroy path.
    child.on("error", () => {});

    const bootstrap = encodeBootstrapHeader(configuration);
    this.#bootstrapped = this.#spawned
      .then(() => this.#writeOne(bootstrap))
      .catch((cause) => {
        throw new NodeSuperBoxChildTransportError(
          "bootstrap_failed",
          "Could not deliver the private SuperBox bootstrap header",
          { cause },
        );
      })
      .finally(() => bootstrap.fill(0));
    this.#writeTail = this.#bootstrapped;
  }

  public get observedStderrBytes(): number {
    return this.#stderrBytes;
  }

  public get stderrTruncated(): boolean {
    return this.#stderrTruncated;
  }

  public waitUntilSpawned(): Promise<void> {
    return this.#spawned;
  }

  public waitUntilBootstrapped(): Promise<void> {
    return this.#bootstrapped;
  }

  public write(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return Promise.reject(new NodeSuperBoxChildTransportError(
        "write_failed",
        "SuperBox transport writes must contain bytes",
      ));
    }
    const copied = Buffer.from(bytes);
    const operation = this.#writeTail
      .then(() => this.#writeOne(copied))
      .finally(() => copied.fill(0));
    this.#writeTail = operation.catch(() => {});
    return operation;
  }

  public closeInput(): void {
    if (!this.#didClose) {
      throw new NodeSuperBoxChildTransportError(
        "input_close_before_exit",
        "SuperBox stdin may close only after authoritative child exit",
      );
    }
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.#child.stdin.destroy();
  }

  public destroy(): Promise<void> {
    if (this.#destroyPromise !== undefined) return this.#destroyPromise;
    this.#destroyPromise = this.#destroyOperation();
    return this.#destroyPromise;
  }

  public waitForExit(): Promise<SuperBoxProcessExitReceiptV1> {
    return this.#exit;
  }

  async *#stdoutBytes(): AsyncGenerator<Uint8Array> {
    for await (const chunk of this.#child.stdout) {
      if (!(chunk instanceof Buffer)) {
        throw new NodeSuperBoxChildTransportError(
          "spawn_failed",
          "SuperBox stdout changed to an unsupported encoding",
        );
      }
      yield Buffer.from(chunk);
    }
  }

  async #writeOne(bytes: Buffer): Promise<void> {
    if (!this.#didSpawn || this.#didClose || this.#inputClosed || this.#destroyPromise !== undefined) {
      throw new NodeSuperBoxChildTransportError(
        "stdin_unavailable",
        "SuperBox child stdin is unavailable",
      );
    }
    const stream = this.#child.stdin;
    await new Promise<void>((resolveWrite, rejectWrite) => {
      let callbackComplete = false;
      let drainComplete = true;
      let settled = false;
      const settle = (): void => {
        if (!settled && callbackComplete && drainComplete) {
          settled = true;
          stream.off("error", onError);
          stream.off("close", onClose);
          resolveWrite();
        }
      };
      const reject = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        stream.off("error", onError);
        stream.off("close", onClose);
        rejectWrite(new NodeSuperBoxChildTransportError(
          "write_failed",
          "Could not write bytes to the SuperBox Host",
          { cause },
        ));
      };
      const onError = (cause: Error): void => reject(cause);
      const onClose = (): void => reject(new Error("stdin closed"));
      stream.once("error", onError);
      stream.once("close", onClose);
      const accepted = stream.write(bytes, (cause?: Error | null) => {
        if (cause) {
          reject(cause);
          return;
        }
        callbackComplete = true;
        settle();
      });
      if (!accepted) {
        drainComplete = false;
        stream.once("drain", () => {
          drainComplete = true;
          settle();
        });
      }
    });
  }

  async #destroyOperation(): Promise<void> {
    if (this.#didClose) return;
    this.#child.kill("SIGTERM");
    if (await settlesWithin(this.#exit, this.#configuration.gracefulDestroyMilliseconds)) return;
    this.#child.kill("SIGKILL");
    if (await settlesWithin(this.#exit, this.#configuration.forcedDestroyMilliseconds)) return;
    throw new NodeSuperBoxChildTransportError(
      "destroy_failed",
      "SuperBox Host did not close after forced destruction",
    );
  }

  #observeStderr(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    const remaining = Math.max(0, this.#configuration.maximumStderrBytes - this.#stderrBytes);
    this.#stderrBytes += Math.min(remaining, chunk.byteLength);
    if (chunk.byteLength > remaining) this.#stderrTruncated = true;
  }
}

function encodeBootstrapHeader(configuration: ValidatedConfiguration): Buffer {
  const bytes = Buffer.alloc(SUPERBOX_BOOTSTRAP_BYTES);
  SUPERBOX_BOOTSTRAP_MAGIC.copy(bytes, 0);
  if (bytes.write(configuration.sealedManifest.sha256, 8, 32, "hex") !== 32) {
    bytes.fill(0);
    throw new NodeSuperBoxChildTransportError(
      "invalid_configuration",
      "Sealed manifest identity could not be encoded",
    );
  }
  return bytes;
}

function validateConfiguration(
  value: LaunchSuperBoxNodeChildTransportV1,
): ValidatedConfiguration {
  if (value === null || typeof value !== "object") invalidConfiguration();
  const maximumStderrBytes = positiveInteger(
    value.maximumStderrBytes,
    DEFAULT_MAXIMUM_STDERR_BYTES,
  );
  const gracefulDestroyMilliseconds = positiveInteger(
    value.gracefulDestroyMilliseconds,
    DEFAULT_GRACEFUL_DESTROY_MILLISECONDS,
  );
  const forcedDestroyMilliseconds = positiveInteger(
    value.forcedDestroyMilliseconds,
    DEFAULT_FORCED_DESTROY_MILLISECONDS,
  );
  validateTrustedFileDeclaration(value.hostExecutable);
  validateTrustedFileDeclaration(value.sealedManifest);
  return Object.freeze({
    hostExecutable: Object.freeze({ ...value.hostExecutable }),
    sealedManifest: Object.freeze({ ...value.sealedManifest }),
    maximumStderrBytes,
    gracefulDestroyMilliseconds,
    forcedDestroyMilliseconds,
  });
}

function validateTrustedFileDeclaration(value: TrustedSuperBoxRegularFileV1): void {
  if (
    value === null
    || typeof value !== "object"
    || !isAbsolute(value.absolutePath)
    || resolve(value.absolutePath) !== value.absolutePath
    || value.absolutePath.includes("\0")
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    invalidConfiguration();
  }
}

async function validateTrustedRegularFile(
  declaration: TrustedSuperBoxRegularFileV1,
  maximumBytes: number,
  executable: boolean,
): Promise<TrustedSuperBoxRegularFileV1> {
  // Resolve only the parent. This accepts macOS's canonical /var -> /private/var
  // parent alias while preserving the final component for the no-symlink lstat/open checks.
  const canonicalParent = await realpath(dirname(declaration.absolutePath)).catch(() => "");
  const canonicalPath = canonicalParent === ""
    ? ""
    : join(canonicalParent, basename(declaration.absolutePath));
  const pathMetadata = await lstat(canonicalPath, { bigint: true })
    .catch(() => undefined);
  if (
    pathMetadata === undefined
    || !pathMetadata.isFile()
    || pathMetadata.isSymbolicLink()
    || pathMetadata.nlink !== 1n
    || pathMetadata.size !== BigInt(declaration.byteLength)
    || pathMetadata.size > BigInt(maximumBytes)
    || (pathMetadata.mode & 0o022n) !== 0n
    || (executable && (pathMetadata.mode & 0o111n) === 0n)
    || (typeof process.getuid === "function"
      && pathMetadata.uid !== BigInt(process.getuid())
      && pathMetadata.uid !== 0n)
    || await realpath(canonicalPath).catch(() => "") !== canonicalPath
  ) {
    throw new NodeSuperBoxChildTransportError(
      "unsafe_file",
      "A trusted SuperBox file failed metadata validation",
    );
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow).catch((cause) => {
    throw new NodeSuperBoxChildTransportError(
      "unsafe_file",
      "A trusted SuperBox file could not be opened safely",
      { cause },
    );
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.size !== BigInt(declaration.byteLength)
    ) {
      throw new NodeSuperBoxChildTransportError(
        "unsafe_file",
        "A trusted SuperBox file changed before validation",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < declaration.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, declaration.byteLength - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new NodeSuperBoxChildTransportError(
          "unsafe_file",
          "A trusted SuperBox file ended during validation",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = await handle.read(buffer, 0, 1, position);
    const after = await handle.stat({ bigint: true });
    if (
      trailing.bytesRead !== 0
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mode !== before.mode
      || after.uid !== before.uid
      || after.gid !== before.gid
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || hash.digest("hex") !== declaration.sha256
    ) {
      throw new NodeSuperBoxChildTransportError(
        "unsafe_file",
        "A trusted SuperBox file failed digest validation",
      );
    }
  } finally {
    await handle.close();
  }
  return Object.freeze({ ...declaration, absolutePath: canonicalPath });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) invalidConfiguration();
  return selected;
}

function invalidConfiguration(): never {
  throw new NodeSuperBoxChildTransportError(
    "invalid_configuration",
    "SuperBox child transport configuration is invalid",
  );
}

async function settlesWithin(
  operation: PromiseLike<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), milliseconds);
    timer.unref();
  });
  const settled = Promise.resolve(operation).then(() => true);
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
