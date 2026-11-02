import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES } from "../superbox/index.js";
import type { TahCredentialEnvelopeSourceV1 } from "./superbox-attempt-port.js";

export interface PrototypeCredentialFileRouteV1 {
  readonly providerID: string;
  readonly absolutePath: string;
}

/**
 * Prototype-only opaque credential loader. Production App integration must
 * replace it with the App credential vault while preserving ownership transfer.
 */
export class PrototypeFileCredentialSourceV1 implements TahCredentialEnvelopeSourceV1 {
  readonly #paths: ReadonlyMap<string, string>;

  public constructor(routes: readonly PrototypeCredentialFileRouteV1[]) {
    if (!Array.isArray(routes) || routes.length === 0 || routes.length > 32) {
      throw new TypeError("Prototype credential routes must contain one to 32 entries");
    }
    const paths = new Map<string, string>();
    for (const route of routes) {
      if (route === null
        || typeof route !== "object"
        || !/^[a-z][a-z0-9_-]{0,63}$/u.test(route.providerID)
        || typeof route.absolutePath !== "string"
        || !isAbsolute(route.absolutePath)
        || resolve(route.absolutePath) !== route.absolutePath
        || route.absolutePath.includes("\0")
        || paths.has(route.providerID)) {
        throw new TypeError("Prototype credential route is invalid or duplicated");
      }
      paths.set(route.providerID, route.absolutePath);
    }
    this.#paths = paths;
  }

  public async takeCredentialEnvelope(
    providerID: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    if (signal?.aborted) throw cancelledRead();
    const declaredPath = this.#paths.get(providerID);
    if (declaredPath === undefined) return null;

    const canonicalParent = await realpath(dirname(declaredPath)).catch((cause: unknown) => {
      if (isMissingFile(cause)) return null;
      throw credentialUnavailable();
    });
    if (canonicalParent === null) return null;
    const path = join(canonicalParent, basename(declaredPath));
    const metadata = await lstat(path, { bigint: true }).catch((cause: unknown) => {
      if (isMissingFile(cause)) return undefined;
      throw credentialUnavailable();
    });
    if (metadata === undefined) return null;
    if (!safeCredentialMetadata(metadata)
      || await realpath(path).catch(() => "") !== path) {
      throw credentialUnavailable();
    }

    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow).catch(() => undefined);
    if (handle === undefined) throw credentialUnavailable();
    try {
      const before = await handle.stat({ bigint: true });
      if (!sameFile(metadata, before)) throw credentialUnavailable();
      const bytes = await readExact(handle, Number(before.size));
      const after = await handle.stat({ bigint: true });
      if (!sameFile(before, after)
        || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs) {
        bytes.fill(0);
        throw credentialUnavailable();
      }
      if (signal?.aborted) {
        bytes.fill(0);
        throw cancelledRead();
      }
      return bytes;
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

function safeCredentialMetadata(value: BigIntStats | undefined): value is BigIntStats {
  return value !== undefined
    && value.isFile()
    && !value.isSymbolicLink()
    && value.nlink === 1n
    && value.size > 0n
    && value.size <= BigInt(SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES)
    && (value.mode & 0o777n) === 0o600n
    && (typeof process.getuid !== "function" || value.uid === BigInt(process.getuid()));
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return safeCredentialMetadata(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

async function readExact(handle: FileHandle, byteLength: number): Promise<Buffer> {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (read.bytesRead <= 0) throw credentialUnavailable();
      offset += read.bytesRead;
    }
    return bytes;
  } catch (cause) {
    bytes.fill(0);
    throw cause;
  }
}

function credentialUnavailable(): Error {
  return new Error("The selected Provider credential is unavailable");
}

function cancelledRead(): Error {
  return new Error("The credential read was cancelled");
}

function isMissingFile(value: unknown): boolean {
  return value instanceof Error
    && "code" in value
    && (value as NodeJS.ErrnoException).code === "ENOENT";
}
