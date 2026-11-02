import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
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
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";

import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
  type FrozenAttemptV1,
} from "../../contract/index.js";
import {
  SUPERBOX_MAX_CANDIDATE_DEPTH,
  SUPERBOX_MAX_CANDIDATE_ENTRIES,
  SUPERBOX_MAX_CANDIDATE_FILES,
  SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES,
} from "../../superbox/operation.js";
import type {
  GuestLogicalMaterialV1,
  GuestLogicalWorkspaceV1,
} from "./adapter.js";
import type { GuestCandidateSnapshotV1 } from "./workspace.js";

export interface GuestEndpointWorkspaceBackendV1 extends GuestLogicalWorkspaceV1 {
  verifyFrozenMaterials(): void;
  candidateSnapshot(): readonly GuestCandidateSnapshotV1[];
}

export type GuestEndpointWorkspaceFactoryV1 = (
  attempt: FrozenAttemptV1,
  readMaterial: (relativePath: string) => Uint8Array,
) => GuestEndpointWorkspaceBackendV1;

export interface GuestProviderFilesystemIdentityV1 {
  readonly uid: number;
  readonly gid: number;
}

interface FrozenPhysicalMaterial {
  readonly descriptor: GuestLogicalMaterialV1;
  readonly physicalPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly identity: FileIdentity;
}

interface FileIdentity {
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

interface CandidateManifest {
  readonly entries: readonly CandidateManifestEntry[];
  readonly files: readonly CandidateFileEntry[];
}

interface CandidateManifestEntry extends FileIdentity {
  readonly kind: "directory" | "file";
  readonly relativePath: string;
  readonly physicalPath: string;
}

interface CandidateFileEntry extends CandidateManifestEntry {
  readonly kind: "file";
}

/**
 * Creates the endpoint-private backend factory for one trusted, fresh Guest
 * root. The root is construction data for the appliance, never Provider
 * Contract or Host-wire data.
 */
export function createFilesystemGuestWorkspaceFactoryV1(
  trustedFreshGuestRoot: string,
  providerIdentity?: GuestProviderFilesystemIdentityV1,
): GuestEndpointWorkspaceFactoryV1 {
  return (attempt, readMaterial) => new FilesystemGuestWorkspaceV1(
    trustedFreshGuestRoot,
    attempt,
    readMaterial,
    providerIdentity,
  );
}

export class FilesystemGuestWorkspaceV1 implements GuestEndpointWorkspaceBackendV1 {
  readonly #root: string;
  readonly #rootDevice: number;
  readonly #materials: ReadonlyMap<string, FrozenPhysicalMaterial>;
  readonly #writableRoots: readonly string[];
  readonly #candidateOwner: GuestProviderFilesystemIdentityV1;

  public constructor(
    trustedFreshGuestRoot: string,
    attempt: FrozenAttemptV1,
    readMaterial: (relativePath: string) => Uint8Array,
    providerIdentity?: GuestProviderFilesystemIdentityV1,
  ) {
    if (!isAbsolute(trustedFreshGuestRoot)) {
      throw new FilesystemGuestWorkspaceError("Guest workspace root must be absolute");
    }
    const requestedRoot = resolve(trustedFreshGuestRoot);
    const rootStat = safeLstat(requestedRoot, "Guest workspace root is unavailable");
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new FilesystemGuestWorkspaceError("Guest workspace root must be a real directory");
    }
    const canonicalRoot = realpathSync(requestedRoot);
    if (readdirSync(canonicalRoot).length !== 0) {
      throw new FilesystemGuestWorkspaceError("Guest workspace root is not fresh");
    }

    this.#root = canonicalRoot;
    this.#rootDevice = rootStat.dev;
    this.#writableRoots = Object.freeze([...attempt.workspace.writableRoots]);
    const access = validateProviderIdentity(providerIdentity);
    this.#candidateOwner = Object.freeze({
      uid: access?.uid ?? rootStat.uid,
      gid: access?.gid ?? rootStat.gid,
    });
    assertNonOverlappingRoots(this.#writableRoots);
    for (const material of attempt.workspace.materials) {
      if (isWithinAnyRoot(material.relativePath, this.#writableRoots)) {
        throw new FilesystemGuestWorkspaceError(
          "Frozen input material overlaps a writable root",
        );
      }
    }
    for (const seed of attempt.workspace.candidateSeeds) {
      if (!isWithinAnyRoot(seed.relativePath, this.#writableRoots)) {
        throw new FilesystemGuestWorkspaceError(
          "Candidate seed is outside the writable root",
        );
      }
    }

    chmodSync(this.#root, 0o700);
    const directories = new Set<string>([this.#root]);
    const materials = new Map<string, FrozenPhysicalMaterial>();
    for (const material of attempt.workspace.materials) {
      const physicalPath = this.#physicalPath(material.relativePath);
      ensureDirectories(
        this.#root,
        dirname(material.relativePath),
        this.#rootDevice,
        directories,
      );
      const bytes = Uint8Array.from(readMaterial(material.relativePath));
      if (bytes.byteLength !== material.byteLength
        || sha256(bytes) !== material.sha256) {
        throw new FilesystemGuestWorkspaceError(
          "Material source disagrees with the frozen byte identity",
        );
      }
      writeNewRegularFile(physicalPath, bytes, access === undefined ? 0o400 : 0o444);
      if (access !== undefined) {
        chownSync(physicalPath, 0, 0);
        chmodSync(physicalPath, 0o444);
      }
      const identity = identityOf(safeLstat(physicalPath, "Material was not created"));
      assertRegularSingleLink(identity, "Material is not a single-link regular file");
      if (access !== undefined && (identity.uid !== 0 || identity.gid !== 0)) {
        throw new FilesystemGuestWorkspaceError(
          "Production immutable material is not owned by the Guest controller",
        );
      }
      materials.set(material.relativePath, Object.freeze({
        descriptor: Object.freeze({
          relativePath: material.relativePath,
          mediaType: material.mediaType,
          byteLength: material.byteLength,
        }),
        physicalPath,
        byteLength: material.byteLength,
        sha256: material.sha256,
        identity,
      }));
    }

    for (const seed of attempt.workspace.candidateSeeds) {
      if (seed.kind === "directory") {
        ensureDirectories(
          this.#root,
          seed.relativePath,
          this.#rootDevice,
          directories,
        );
        continue;
      }
      const physicalPath = this.#physicalPath(seed.relativePath);
      ensureDirectories(
        this.#root,
        dirname(seed.relativePath),
        this.#rootDevice,
        directories,
      );
      const bytes = Uint8Array.from(readMaterial(seed.relativePath));
      if (bytes.byteLength !== seed.byteLength || sha256(bytes) !== seed.sha256) {
        throw new FilesystemGuestWorkspaceError(
          "Candidate seed disagrees with the frozen byte identity",
        );
      }
      writeNewRegularFile(physicalPath, bytes, 0o600);
      if (access !== undefined) {
        chownSync(physicalPath, access.uid, access.gid);
        chmodSync(physicalPath, 0o600);
      }
    }

    for (const writableRoot of this.#writableRoots) {
      ensureDirectories(
        this.#root,
        writableRoot,
        this.#rootDevice,
        directories,
      );
    }
    const writablePhysicalRoots = new Set(
      this.#writableRoots.map((root) => this.#physicalPath(root)),
    );
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      if ([...writablePhysicalRoots].some((root) => isContainedPath(root, directory))) {
        if (access !== undefined) chownSync(directory, access.uid, access.gid);
        chmodSync(directory, 0o700);
      } else {
        if (access !== undefined) chownSync(directory, 0, 0);
        chmodSync(directory, access === undefined ? 0o500 : 0o555);
      }
    }
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
      throw new FilesystemGuestWorkspaceError("Material was not declared");
    }
    return Uint8Array.from(readStableFile(material.physicalPath, material.identity));
  }

  /** Convenience collector for fixture Adapters; native tools write the same root directly. */
  public putCandidate(relativePath: string, bytes: Uint8Array): void {
    assertPortableRelativePath(relativePath);
    const writableRoot = longestContainingRoot(relativePath, this.#writableRoots);
    if (writableRoot === undefined || relativePath === writableRoot) {
      throw new FilesystemGuestWorkspaceError(
        "Candidate path is outside the frozen writable file scope",
      );
    }
    const rootPath = this.#physicalPath(writableRoot);
    assertSafeDirectory(rootPath, this.#root, this.#rootDevice, this.#candidateOwner);
    const relativeToRoot = relativePath.slice(writableRoot.length + 1);
    const candidateDirectories = new Set<string>();
    ensureDirectories(rootPath, dirname(relativeToRoot), this.#rootDevice, candidateDirectories);
    writeNewRegularFile(this.#physicalPath(relativePath), Uint8Array.from(bytes), 0o600);
  }

  public verifyFrozenMaterials(): void {
    for (const material of this.#materials.values()) {
      const current = safeLstat(material.physicalPath, "Frozen material is missing");
      const identity = identityOf(current);
      assertRegularSingleLink(identity, "Frozen material type or link count changed");
      if (!sameFileIdentity(identity, material.identity)) {
        throw new FilesystemGuestWorkspaceError("Frozen material identity changed");
      }
      if ((identity.mode & 0o222) !== 0) {
        throw new FilesystemGuestWorkspaceError("Frozen material became writable");
      }
      this.#assertContainedRealPath(material.physicalPath);
      const bytes = readStableFile(material.physicalPath, identity);
      if (bytes.byteLength !== material.byteLength || sha256(bytes) !== material.sha256) {
        throw new FilesystemGuestWorkspaceError("Frozen material bytes changed");
      }
    }
  }

  public candidateSnapshot(): readonly GuestCandidateSnapshotV1[] {
    this.verifyFrozenMaterials();
    const before = this.#collectCandidateManifest();
    const snapshots = before.entries.map((entry): GuestCandidateSnapshotV1 =>
      entry.kind === "directory"
        ? Object.freeze({ kind: "directory", relativePath: entry.relativePath })
        : Object.freeze({
            kind: "file",
            relativePath: entry.relativePath,
            bytes: Uint8Array.from(readStableFile(entry.physicalPath, entry)),
          })
    );
    const after = this.#collectCandidateManifest();
    if (!sameManifest(before.entries, after.entries)) {
      throw new FilesystemGuestWorkspaceError("Candidate tree changed during collection");
    }
    this.verifyFrozenMaterials();
    return Object.freeze(snapshots);
  }

  #collectCandidateManifest(): CandidateManifest {
    const entries = new Map<string, CandidateManifestEntry>();
    const files: CandidateFileEntry[] = [];
    let totalBytes = 0;

    for (const writableRoot of this.#writableRoots) {
      const rootPath = this.#physicalPath(writableRoot);
      assertSafeDirectory(rootPath, this.#root, this.#rootDevice, this.#candidateOwner);
      this.#walkCandidateDirectory(writableRoot, rootPath, 0, entries, files, (size) => {
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes)
          || totalBytes > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES) {
          throw new FilesystemGuestWorkspaceError(
            "Candidate bytes exceed the operation bound",
          );
        }
      });
    }

    return Object.freeze({
      entries: Object.freeze([...entries.values()].sort(compareManifestEntry)),
      files: Object.freeze(files.sort(compareManifestEntry)),
    });
  }

  #walkCandidateDirectory(
    logicalDirectory: string,
    physicalDirectory: string,
    parentDepth: number,
    entries: Map<string, CandidateManifestEntry>,
    files: CandidateFileEntry[],
    consumeBytes: (size: number) => void,
  ): void {
    for (const name of readdirSync(physicalDirectory).sort(compareCanonicalUTF8V1)) {
      const depth = parentDepth + 1;
      if (depth > SUPERBOX_MAX_CANDIDATE_DEPTH) {
        throw new FilesystemGuestWorkspaceError("Candidate tree exceeds its depth bound");
      }
      const relativePath = `${logicalDirectory}/${name}`;
      assertPortableRelativePath(relativePath);
      if (entries.has(relativePath)) {
        throw new FilesystemGuestWorkspaceError("Candidate path was discovered more than once");
      }
      if (entries.size >= SUPERBOX_MAX_CANDIDATE_ENTRIES) {
        throw new FilesystemGuestWorkspaceError(
          "Candidate tree exceeds its total entry-count bound",
        );
      }
      const physicalPath = join(physicalDirectory, name);
      const stat = safeLstat(physicalPath, "Candidate entry disappeared during scan");
      if (stat.isSymbolicLink()) {
        throw new FilesystemGuestWorkspaceError("Candidate tree contains a symlink");
      }
      if (stat.dev !== this.#rootDevice) {
        throw new FilesystemGuestWorkspaceError("Candidate tree crosses a filesystem boundary");
      }
      this.#assertContainedRealPath(physicalPath);
      const identity = identityOf(stat);
      assertExpectedOwner(
        identity,
        this.#candidateOwner,
        "Candidate entry owner does not match the Provider identity",
      );
      if (stat.isDirectory()) {
        const entry: CandidateManifestEntry = Object.freeze({
          kind: "directory",
          relativePath,
          physicalPath,
          ...identity,
        });
        entries.set(relativePath, entry);
        this.#walkCandidateDirectory(
          relativePath,
          physicalPath,
          depth,
          entries,
          files,
          consumeBytes,
        );
      } else if (stat.isFile()) {
        assertRegularSingleLink(identity, "Candidate is not a single-link regular file");
        if (files.length >= SUPERBOX_MAX_CANDIDATE_FILES) {
          throw new FilesystemGuestWorkspaceError(
            "Candidate file count exceeds the operation bound",
          );
        }
        consumeBytes(identity.size);
        const entry: CandidateFileEntry = Object.freeze({
          kind: "file",
          relativePath,
          physicalPath,
          ...identity,
        });
        entries.set(relativePath, entry);
        files.push(entry);
      } else {
        throw new FilesystemGuestWorkspaceError(
          "Candidate tree contains a special filesystem entry",
        );
      }
    }
  }

  #physicalPath(relativePath: string): string {
    assertPortableRelativePath(relativePath);
    const physicalPath = resolve(this.#root, relativePath);
    if (!isContainedPath(this.#root, physicalPath)) {
      throw new FilesystemGuestWorkspaceError("Logical path escapes the Guest workspace root");
    }
    return physicalPath;
  }

  #assertContainedRealPath(physicalPath: string): void {
    const canonical = realpathSync(physicalPath);
    if (!isContainedPath(this.#root, canonical)) {
      throw new FilesystemGuestWorkspaceError("Filesystem entry escapes the Guest workspace root");
    }
  }
}

function validateProviderIdentity(
  value: GuestProviderFilesystemIdentityV1 | undefined,
): GuestProviderFilesystemIdentityV1 | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value.uid)
    || !Number.isSafeInteger(value.gid)
    || value.uid <= 0
    || value.gid <= 0
    || value.uid > 0x7fff_ffff
    || value.gid > 0x7fff_ffff
  ) {
    throw new FilesystemGuestWorkspaceError("Provider filesystem identity is invalid");
  }
  if (process.getuid === undefined || process.getuid() !== 0) {
    throw new FilesystemGuestWorkspaceError(
      "Provider filesystem ownership requires the trusted root Guest controller",
    );
  }
  return Object.freeze({ uid: value.uid, gid: value.gid });
}

function ensureDirectories(
  physicalRoot: string,
  logicalDirectory: string,
  expectedDevice: number,
  observed: Set<string>,
): void {
  if (logicalDirectory === "." || logicalDirectory.length === 0) return;
  assertPortableRelativePath(logicalDirectory);
  let current = physicalRoot;
  for (const component of logicalDirectory.split("/")) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expectedDevice) {
        throw new FilesystemGuestWorkspaceError("Workspace path contains an unsafe directory");
      }
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
      mkdirSync(current, { mode: 0o700 });
    }
    const canonical = realpathSync(current);
    if (!isContainedPath(physicalRoot, canonical)) {
      throw new FilesystemGuestWorkspaceError("Workspace directory escapes its trusted root");
    }
    observed.add(current);
  }
}

function assertSafeDirectory(
  path: string,
  root: string,
  expectedDevice: number,
  expectedOwner: GuestProviderFilesystemIdentityV1,
): void {
  const stat = safeLstat(path, "Writable root is missing");
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expectedDevice) {
    throw new FilesystemGuestWorkspaceError("Writable root is not a safe directory");
  }
  if (!isContainedPath(root, realpathSync(path))) {
    throw new FilesystemGuestWorkspaceError("Writable root escapes the Guest workspace");
  }
  assertExpectedOwner(
    identityOf(stat),
    expectedOwner,
    "Writable root owner does not match the Provider identity",
  );
}

function assertExpectedOwner(
  identity: FileIdentity,
  expected: GuestProviderFilesystemIdentityV1,
  message: string,
): void {
  if (identity.uid !== expected.uid || identity.gid !== expected.gid) {
    throw new FilesystemGuestWorkspaceError(message);
  }
}

function writeNewRegularFile(path: string, bytes: Uint8Array, mode: number): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = writeSync(descriptor, buffer, offset, buffer.byteLength - offset);
      if (written <= 0) throw new FilesystemGuestWorkspaceError("File write made no progress");
      offset += written;
    }
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readStableFile(path: string, expected: FileIdentity): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = identityOf(fstatSync(descriptor));
    assertRegularSingleLink(before, "File is not a single-link regular file");
    if (!sameFileIdentity(before, expected)) {
      throw new FilesystemGuestWorkspaceError("File identity changed before read");
    }
    if (before.size > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new FilesystemGuestWorkspaceError("File exceeds the operation byte bound");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count <= 0) throw new FilesystemGuestWorkspaceError("File truncated during read");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new FilesystemGuestWorkspaceError("File grew during read");
    }
    const after = identityOf(fstatSync(descriptor));
    if (!sameFileIdentity(before, after)) {
      throw new FilesystemGuestWorkspaceError("File changed during read");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function identityOf(stat: Stats): FileIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    uid: stat.uid,
    gid: stat.gid,
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.uid === right.uid
    && left.gid === right.gid;
}

function sameManifest(
  left: readonly CandidateManifestEntry[],
  right: readonly CandidateManifestEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.kind === other.kind
      && entry.relativePath === other.relativePath
      && entry.physicalPath === other.physicalPath
      && sameFileIdentity(entry, other);
  });
}

function compareManifestEntry(
  left: CandidateManifestEntry,
  right: CandidateManifestEntry,
): number {
  return compareCanonicalUTF8V1(left.relativePath, right.relativePath);
}

function assertRegularSingleLink(identity: FileIdentity, message: string): void {
  if ((identity.mode & fsConstants.S_IFMT) !== fsConstants.S_IFREG || identity.nlink !== 1) {
    throw new FilesystemGuestWorkspaceError(message);
  }
}

function assertNonOverlappingRoots(roots: readonly string[]): void {
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const right = roots[rightIndex]!;
      if (isWithinRoot(left, right) || isWithinRoot(right, left)) {
        throw new FilesystemGuestWorkspaceError("Writable roots overlap");
      }
    }
  }
}

function longestContainingRoot(
  relativePath: string,
  roots: readonly string[],
): string | undefined {
  return roots
    .filter((root) => isWithinRoot(relativePath, root))
    .sort((left, right) => right.length - left.length)[0];
}

function isWithinAnyRoot(relativePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithinRoot(relativePath, root));
}

function isWithinRoot(relativePath: string, root: string): boolean {
  return relativePath === root || relativePath.startsWith(`${root}/`);
}

function isContainedPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertPortableRelativePath(value: string): void {
  if (!isCanonicalUTF8V1(value)
    || value.length === 0
    || value.length > 1_024
    || isAbsolute(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new FilesystemGuestWorkspaceError("Path is not a portable relative path");
  }
}

function safeLstat(path: string, message: string): Stats {
  try {
    return lstatSync(path);
  } catch (cause) {
    throw new FilesystemGuestWorkspaceError(message, { cause });
  }
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error
    && "code" in cause
    && (cause as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FilesystemGuestWorkspaceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesystemGuestWorkspaceError";
  }
}
