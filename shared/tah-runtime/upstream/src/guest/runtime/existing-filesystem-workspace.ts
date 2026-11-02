import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
  type FrozenAttemptV1,
} from "../../contract/index.js";
import {
  SUPERBOX_MAX_CANDIDATE_DEPTH,
  SUPERBOX_MAX_CANDIDATE_ENTRIES,
  SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES,
} from "../../superbox/operation.js";
import type {
  GuestLogicalMaterialV1,
  GuestLogicalWorkspaceV1,
} from "./adapter.js";

interface MaterialIdentityV1 {
  readonly descriptor: GuestLogicalMaterialV1;
  readonly physicalPath: string;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly uid: number;
  readonly gid: number;
}

export interface ExistingFilesystemWorkspaceOwnershipV1 {
  readonly controllerUID: number;
  readonly controllerGID: number;
  readonly providerUID: number;
  readonly providerGID: number;
}

/**
 * Child-side logical view over the workspace already materialized by the
 * trusted root Guest endpoint. The physical root is fixed appliance
 * construction data and is never exposed through this interface.
 */
export class ExistingFilesystemGuestWorkspaceV1 implements GuestLogicalWorkspaceV1 {
  readonly #root: string;
  readonly #rootDevice: number;
  readonly #materials: ReadonlyMap<string, MaterialIdentityV1>;
  readonly #writableRoots: readonly string[];
  readonly #ownership: ExistingFilesystemWorkspaceOwnershipV1 | undefined;

  public constructor(
    trustedWorkspaceRoot: string,
    attempt: FrozenAttemptV1,
    ownership?: ExistingFilesystemWorkspaceOwnershipV1,
  ) {
    if (!isAbsolute(trustedWorkspaceRoot) || resolve(trustedWorkspaceRoot) !== trustedWorkspaceRoot) {
      throw new ExistingFilesystemWorkspaceError("Existing Guest workspace path is invalid");
    }
    const rootStat = safeLstat(trustedWorkspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ExistingFilesystemWorkspaceError("Existing Guest workspace is not a real directory");
    }
    const root = realpathSync(trustedWorkspaceRoot);
    if (root !== trustedWorkspaceRoot) {
      throw new ExistingFilesystemWorkspaceError("Existing Guest workspace is not canonical");
    }
    this.#root = root;
    this.#rootDevice = rootStat.dev;
    this.#writableRoots = Object.freeze([...attempt.workspace.writableRoots]);
    this.#ownership = validateOwnership(ownership);
    this.#assertControllerDirectory(rootStat);

    const materials = new Map<string, MaterialIdentityV1>();
    for (const declaration of attempt.workspace.materials) {
      const physicalPath = this.#physicalPath(declaration.relativePath);
      this.#assertControllerAncestors(declaration.relativePath);
      const stat = safeLstat(physicalPath);
      assertFrozenMaterial(stat, this.#rootDevice, declaration.byteLength);
      this.#assertControllerOwned(stat);
      this.#assertContainedRealPath(physicalPath);
      materials.set(declaration.relativePath, Object.freeze({
        descriptor: Object.freeze({
          relativePath: declaration.relativePath,
          mediaType: declaration.mediaType,
          byteLength: declaration.byteLength,
        }),
        physicalPath,
        sha256: declaration.sha256,
        ...identity(stat),
      }));
    }
    for (const writableRoot of this.#writableRoots) {
      const physicalPath = this.#physicalPath(writableRoot);
      this.#assertControllerAncestors(writableRoot);
      const stat = safeLstat(physicalPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#rootDevice) {
        throw new ExistingFilesystemWorkspaceError("Writable root is not a safe directory");
      }
      this.#assertContainedRealPath(physicalPath);
      this.#assertProviderDirectory(stat);
    }
    this.#verifyExactCandidateSeeds(attempt);
    this.#materials = materials;
  }

  public listMaterials(): readonly GuestLogicalMaterialV1[] {
    return Object.freeze(
      [...this.#materials.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) =>
          compareCanonicalUTF8V1(left.relativePath, right.relativePath)
        ),
    );
  }

  public readMaterial(relativePath: string): Uint8Array {
    const material = this.#materials.get(relativePath);
    if (material === undefined) {
      throw new ExistingFilesystemWorkspaceError("Material was not declared");
    }
    const bytes = readStable(material.physicalPath, material);
    if (sha256(bytes) !== material.sha256) {
      throw new ExistingFilesystemWorkspaceError("Frozen material bytes changed");
    }
    return Uint8Array.from(bytes);
  }

  public putCandidate(relativePath: string, bytes: Uint8Array): void {
    assertPortableRelativePath(relativePath);
    if (!(bytes instanceof Uint8Array)
      || bytes.byteLength > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new ExistingFilesystemWorkspaceError("Candidate bytes are invalid");
    }
    const writableRoot = longestContainingRoot(relativePath, this.#writableRoots);
    if (writableRoot === undefined || relativePath === writableRoot) {
      throw new ExistingFilesystemWorkspaceError("Candidate path is outside the writable scope");
    }
    const rootPath = this.#physicalPath(writableRoot);
    assertSafeDirectory(rootPath, this.#root, this.#rootDevice);
    const relativeToRoot = relativePath.slice(writableRoot.length + 1);
    ensureCandidateDirectories(rootPath, dirname(relativeToRoot), this.#rootDevice);
    writeNewFile(this.#physicalPath(relativePath), bytes);
  }

  #verifyExactCandidateSeeds(attempt: FrozenAttemptV1): void {
    const declarations = new Map(
      attempt.workspace.candidateSeeds.map((seed) => [seed.relativePath, seed]),
    );
    const observed = new Set<string>();
    for (const writableRoot of this.#writableRoots) {
      this.#walkSeedDirectory(writableRoot, 0, declarations, observed);
    }
    if (observed.size !== declarations.size
      || [...declarations.keys()].some((path) => !observed.has(path))) {
      throw new ExistingFilesystemWorkspaceError(
        "Existing Guest workspace does not exactly match the candidate seed manifest",
      );
    }
  }

  #walkSeedDirectory(
    logicalDirectory: string,
    parentDepth: number,
    declarations: ReadonlyMap<string, FrozenAttemptV1["workspace"]["candidateSeeds"][number]>,
    observed: Set<string>,
  ): void {
    const physicalDirectory = this.#physicalPath(logicalDirectory);
    for (const name of readdirSync(physicalDirectory).sort(compareCanonicalUTF8V1)) {
      const depth = parentDepth + 1;
      if (depth > SUPERBOX_MAX_CANDIDATE_DEPTH
        || observed.size >= SUPERBOX_MAX_CANDIDATE_ENTRIES) {
        throw new ExistingFilesystemWorkspaceError(
          "Candidate seed tree exceeds its structural bound",
        );
      }
      const relativePath = `${logicalDirectory}/${name}`;
      assertPortableRelativePath(relativePath);
      const declaration = declarations.get(relativePath);
      if (declaration === undefined || observed.has(relativePath)) {
        throw new ExistingFilesystemWorkspaceError(
          "Existing Guest workspace contains an undeclared candidate seed entry",
        );
      }
      const physicalPath = this.#physicalPath(relativePath);
      const stat = safeLstat(physicalPath);
      if (stat.isSymbolicLink() || stat.dev !== this.#rootDevice) {
        throw new ExistingFilesystemWorkspaceError("Candidate seed entry is unsafe");
      }
      this.#assertContainedRealPath(physicalPath);
      observed.add(relativePath);
      if (declaration.kind === "directory") {
        if (!stat.isDirectory()) {
          throw new ExistingFilesystemWorkspaceError(
            "Candidate seed directory has the wrong filesystem type",
          );
        }
        this.#assertProviderDirectory(stat);
        this.#walkSeedDirectory(relativePath, depth, declarations, observed);
        continue;
      }
      assertFrozenMaterial(stat, this.#rootDevice, declaration.byteLength, true);
      this.#assertProviderFile(stat);
      const expected: MaterialIdentityV1 = {
        descriptor: {
          relativePath,
          mediaType: declaration.mediaType,
          byteLength: declaration.byteLength,
        },
        physicalPath,
        sha256: declaration.sha256,
        ...identity(stat),
      };
      const bytes = readStable(physicalPath, expected, true);
      try {
        if (sha256(bytes) !== declaration.sha256) {
          throw new ExistingFilesystemWorkspaceError("Candidate seed file digest changed");
        }
      } finally {
        bytes.fill(0);
      }
    }
  }

  #assertControllerOwned(stat: Stats): void {
    const expected = this.#ownership;
    if (expected === undefined) return;
    if (stat.uid !== expected.controllerUID
      || stat.gid !== expected.controllerGID
      || (stat.mode & 0o777) !== 0o444) {
      throw new ExistingFilesystemWorkspaceError(
        "Immutable material ownership or mode is invalid",
      );
    }
  }

  #assertControllerAncestors(relativePath: string): void {
    const parts = dirname(relativePath).split("/").filter((part) => part !== ".");
    let current = this.#root;
    for (const part of parts) {
      current = resolve(current, part);
      const stat = safeLstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#rootDevice) {
        throw new ExistingFilesystemWorkspaceError("Immutable workspace ancestor is unsafe");
      }
      this.#assertContainedRealPath(current);
      this.#assertControllerDirectory(stat);
    }
  }

  #assertControllerDirectory(stat: Stats): void {
    const expected = this.#ownership;
    if (expected === undefined) return;
    if (stat.uid !== expected.controllerUID
      || stat.gid !== expected.controllerGID
      || (stat.mode & 0o777) !== 0o555) {
      throw new ExistingFilesystemWorkspaceError(
        "Immutable workspace directory ownership or mode is invalid",
      );
    }
  }

  #assertProviderDirectory(stat: Stats): void {
    const expected = this.#ownership;
    if (expected === undefined) return;
    if (stat.uid !== expected.providerUID
      || stat.gid !== expected.providerGID
      || (stat.mode & 0o777) !== 0o700) {
      throw new ExistingFilesystemWorkspaceError(
        "Candidate directory ownership or mode is invalid",
      );
    }
  }

  #assertProviderFile(stat: Stats): void {
    const expected = this.#ownership;
    if (expected === undefined) return;
    if (stat.uid !== expected.providerUID
      || stat.gid !== expected.providerGID
      || (stat.mode & 0o777) !== 0o600) {
      throw new ExistingFilesystemWorkspaceError(
        "Candidate seed file ownership or mode is invalid",
      );
    }
  }

  #physicalPath(relativePath: string): string {
    assertPortableRelativePath(relativePath);
    const physicalPath = resolve(this.#root, relativePath);
    if (!isContained(this.#root, physicalPath)) {
      throw new ExistingFilesystemWorkspaceError("Logical path escaped the Guest workspace");
    }
    return physicalPath;
  }

  #assertContainedRealPath(path: string): void {
    if (!isContained(this.#root, realpathSync(path))) {
      throw new ExistingFilesystemWorkspaceError("Workspace entry escaped its root");
    }
  }
}

function readStable(
  path: string,
  expected: MaterialIdentityV1,
  allowWritable = false,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    assertFrozenMaterial(before, expected.dev, expected.size, allowWritable);
    if (!sameIdentity(before, expected)) {
      throw new ExistingFilesystemWorkspaceError("Frozen material identity changed");
    }
    const result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.byteLength) {
      const count = readSync(descriptor, result, offset, result.byteLength - offset, offset);
      if (count <= 0) throw new ExistingFilesystemWorkspaceError("Material read made no progress");
      offset += count;
    }
    if (!sameIdentity(fstatSync(descriptor), expected)) {
      result.fill(0);
      throw new ExistingFilesystemWorkspaceError("Frozen material changed during read");
    }
    return result;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeNewFile(path: string, bytes: Uint8Array): void {
  let descriptor: number | undefined;
  const source = Buffer.from(bytes);
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < source.byteLength) {
      const count = writeSync(descriptor, source, offset, source.byteLength - offset);
      if (count <= 0) throw new ExistingFilesystemWorkspaceError("Candidate write made no progress");
      offset += count;
    }
    fsyncSync(descriptor);
  } finally {
    source.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureCandidateDirectories(root: string, relative: string, device: number): void {
  if (relative === "." || relative.length === 0) return;
  assertPortableRelativePath(relative);
  let current = root;
  for (const component of relative.split("/")) {
    current = resolve(current, component);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device) {
        throw new ExistingFilesystemWorkspaceError("Candidate path contains an unsafe directory");
      }
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      mkdirSync(current, { mode: 0o700 });
    }
    if (!isContained(root, realpathSync(current))) {
      throw new ExistingFilesystemWorkspaceError("Candidate directory escaped its root");
    }
  }
}

function assertFrozenMaterial(
  stat: Stats,
  device: number,
  size: number,
  allowWritable = false,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.dev !== device || stat.size !== size
    || (!allowWritable && (stat.mode & 0o222) !== 0)) {
    throw new ExistingFilesystemWorkspaceError("Frozen material is not immutable");
  }
}

function assertSafeDirectory(path: string, root: string, device: number): void {
  const stat = safeLstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device
    || !isContained(root, realpathSync(path))) {
    throw new ExistingFilesystemWorkspaceError("Writable root is unsafe");
  }
}

function identity(stat: Stats) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function sameIdentity(stat: Stats, expected: MaterialIdentityV1): boolean {
  const current = identity(stat);
  return current.dev === expected.dev
    && current.ino === expected.ino
    && current.mode === expected.mode
    && current.nlink === expected.nlink
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
    && current.uid === expected.uid
    && current.gid === expected.gid;
}

function validateOwnership(
  value: ExistingFilesystemWorkspaceOwnershipV1 | undefined,
): ExistingFilesystemWorkspaceOwnershipV1 | undefined {
  if (value === undefined) return undefined;
  for (const identity of [
    value.controllerUID,
    value.controllerGID,
    value.providerUID,
    value.providerGID,
  ]) {
    if (!Number.isSafeInteger(identity) || identity < 0 || identity > 0x7fff_ffff) {
      throw new ExistingFilesystemWorkspaceError("Workspace ownership policy is invalid");
    }
  }
  if (value.providerUID === 0 || value.providerGID === 0) {
    throw new ExistingFilesystemWorkspaceError("Provider workspace identity must be unprivileged");
  }
  return Object.freeze({ ...value });
}

function longestContainingRoot(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => path === root || path.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
}

function assertPortableRelativePath(value: string): void {
  if (!isCanonicalUTF8V1(value)
    || value.length === 0 || value.startsWith("/") || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ExistingFilesystemWorkspaceError("Workspace path is invalid");
  }
}

function safeLstat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (cause) {
    throw new ExistingFilesystemWorkspaceError("Workspace entry is unavailable", { cause });
  }
}

function isContained(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null
    && "code" in cause && cause.code === "ENOENT";
}

export class ExistingFilesystemWorkspaceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExistingFilesystemWorkspaceError";
  }
}
