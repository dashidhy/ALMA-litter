import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  statfs,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type {
  DedicatedProviderCgroupLeaseV1,
  DedicatedProviderCgroupPortV1,
} from "./ports.js";

const MAXIMUM_CGROUP_EVENTS_BYTES = 4 * 1024;
const MAXIMUM_CGROUP_PROCS_BYTES = 64 * 1024;
const CGROUP2_SUPER_MAGIC = 0x6367_7270;

/** Direct cgroup-v2 filesystem port. It never invokes a shell or reads ambient env. */
export class LinuxDedicatedProviderCgroupPortV1 implements DedicatedProviderCgroupPortV1 {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  public static async open(trustedCgroupRoot: string): Promise<LinuxDedicatedProviderCgroupPortV1> {
    if (process.platform !== "linux"
      || !isAbsolute(trustedCgroupRoot)
      || resolve(trustedCgroupRoot) !== trustedCgroupRoot
      || trustedCgroupRoot === "/"
      || trustedCgroupRoot.includes("\0")) {
      throw new LinuxCgroupError("invalid_root", "Dedicated cgroup root is invalid");
    }
    const metadata = await lstat(trustedCgroupRoot).catch(() => undefined);
    const canonical = await realpath(trustedCgroupRoot).catch(() => "");
    if (metadata === undefined
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || canonical !== trustedCgroupRoot) {
      throw new LinuxCgroupError("invalid_root", "Dedicated cgroup root is not canonical");
    }
    const filesystem = await statfs(canonical).catch(() => undefined);
    if (filesystem === undefined || Number(filesystem.type) !== CGROUP2_SUPER_MAGIC) {
      throw new LinuxCgroupError("invalid_root", "Dedicated cgroup root is not cgroup v2");
    }
    await validateControlFile(join(canonical, "cgroup.procs"), fsConstants.O_WRONLY);
    await validateControlFile(join(canonical, "cgroup.events"), fsConstants.O_RDONLY);
    await readControlFile(join(canonical, "cgroup.controllers"), MAXIMUM_CGROUP_EVENTS_BYTES);
    return new LinuxDedicatedProviderCgroupPortV1(canonical);
  }

  public async create(scopeID: string): Promise<DedicatedProviderCgroupLeaseV1> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(scopeID)) {
      throw new LinuxCgroupError("invalid_scope", "Dedicated cgroup scope is invalid");
    }
    const path = join(this.#root, `attempt-${scopeID}`);
    if (!isContainedPath(this.#root, path)) {
      throw new LinuxCgroupError("invalid_scope", "Dedicated cgroup path escaped its root");
    }
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (cause) {
      throw new LinuxCgroupError("create_failed", "Could not create dedicated cgroup", { cause });
    }
    try {
      const metadata = await lstat(path).catch(() => undefined);
      const canonical = await realpath(path).catch(() => "");
      if (metadata === undefined
        || !metadata.isDirectory()
        || metadata.isSymbolicLink()
        || canonical !== path) {
        throw new LinuxCgroupError("create_failed", "Created cgroup is not a safe directory");
      }
      // Open every authority-bearing control node before a Provider process or
      // credential can exist. `cgroup.kill` is intentionally not written here.
      await validateControlFile(join(path, "cgroup.procs"), fsConstants.O_WRONLY);
      await validateControlFile(join(path, "cgroup.events"), fsConstants.O_RDONLY);
      await validateControlFile(join(path, "cgroup.kill"), fsConstants.O_WRONLY);
    } catch (cause) {
      await rmdir(path).catch(() => {});
      if (cause instanceof LinuxCgroupError) throw cause;
      throw new LinuxCgroupError(
        "create_failed",
        "Dedicated cgroup control surface is unavailable",
        { cause },
      );
    }
    return new LinuxDedicatedProviderCgroupLeaseV1(path);
  }
}

class LinuxDedicatedProviderCgroupLeaseV1 implements DedicatedProviderCgroupLeaseV1 {
  readonly #path: string;
  #removed = false;

  public constructor(path: string) {
    this.#path = path;
  }

  public async attachBootstrapPID(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new LinuxCgroupError("invalid_pid", "Bootstrap PID is invalid");
    }
    await writeControlFile(join(this.#path, "cgroup.procs"), `${pid}\n`);
  }

  public async verifyBootstrapPlacement(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new LinuxCgroupError("invalid_pid", "Bootstrap PID is invalid");
    }
    const source = await readControlFile(
      join(this.#path, "cgroup.procs"),
      MAXIMUM_CGROUP_PROCS_BYTES,
    );
    const members = source.trimEnd().length === 0
      ? []
      : source.trimEnd().split("\n");
    if (!members.every((member) => /^[1-9][0-9]*$/u.test(member))
      || !members.includes(String(pid))) {
      throw new LinuxCgroupError(
        "placement_unverified",
        "Bootstrap PID membership could not be verified",
      );
    }
    if (!await this.isPopulated()) {
      throw new LinuxCgroupError(
        "placement_unverified",
        "Dedicated cgroup was not populated after bootstrap attachment",
      );
    }
  }

  public async killAll(): Promise<void> {
    await writeControlFile(join(this.#path, "cgroup.kill"), "1\n");
  }

  public async isPopulated(): Promise<boolean> {
    const source = await readControlFile(
      join(this.#path, "cgroup.events"),
      MAXIMUM_CGROUP_EVENTS_BYTES,
    );
    let populated: boolean | undefined;
    const names = new Set<string>();
    for (const line of source.trimEnd().split("\n")) {
      const fields = line.split(" ");
      if (fields.length !== 2 || !/^[a-z_]+$/u.test(fields[0]!)) {
        throw new LinuxCgroupError("events_invalid", "cgroup.events is malformed");
      }
      if (names.has(fields[0]!)) {
        throw new LinuxCgroupError("events_invalid", "cgroup.events repeats a field");
      }
      names.add(fields[0]!);
      if (fields[0] === "populated") {
        if (fields[1] !== "0" && fields[1] !== "1") {
          throw new LinuxCgroupError("events_invalid", "cgroup.events populated value is invalid");
        }
        populated = fields[1] === "1";
      }
    }
    if (populated === undefined) {
      throw new LinuxCgroupError("events_invalid", "cgroup.events omitted populated");
    }
    return populated;
  }

  public async remove(): Promise<void> {
    if (this.#removed) return;
    try {
      await rmdir(this.#path);
      this.#removed = true;
    } catch (cause) {
      throw new LinuxCgroupError("remove_failed", "Could not remove dedicated cgroup", { cause });
    }
  }
}

async function writeControlFile(path: string, value: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LinuxCgroupError("control_invalid", "cgroup control node is not a file");
    }
    const bytes = Buffer.from(value, "ascii");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesWritten <= 0) {
        throw new LinuxCgroupError("control_failed", "cgroup control write made no progress");
      }
      offset += result.bytesWritten;
    }
  } catch (cause) {
    if (cause instanceof LinuxCgroupError) throw cause;
    throw new LinuxCgroupError("control_failed", "Could not write cgroup control node", { cause });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validateControlFile(path: string, flags: number): Promise<void> {
  let handle;
  try {
    handle = await open(path, flags | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LinuxCgroupError("control_invalid", "cgroup control node is not a file");
    }
  } catch (cause) {
    if (cause instanceof LinuxCgroupError) throw cause;
    throw new LinuxCgroupError("control_invalid", "cgroup control node is unavailable", { cause });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readControlFile(path: string, maximumBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new LinuxCgroupError("control_invalid", "cgroup events node is not a file");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(1024, maximumBytes + 1 - total));
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maximumBytes) {
        throw new LinuxCgroupError("events_invalid", "cgroup.events exceeds its byte bound");
      }
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, total).toString("ascii");
  } catch (cause) {
    if (cause instanceof LinuxCgroupError) throw cause;
    throw new LinuxCgroupError("control_failed", "Could not read cgroup events", { cause });
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export type LinuxCgroupErrorCode =
  | "invalid_root"
  | "invalid_scope"
  | "create_failed"
  | "invalid_pid"
  | "placement_unverified"
  | "control_invalid"
  | "control_failed"
  | "events_invalid"
  | "remove_failed";

export class LinuxCgroupError extends Error {
  public constructor(
    public readonly code: LinuxCgroupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LinuxCgroupError";
  }
}
