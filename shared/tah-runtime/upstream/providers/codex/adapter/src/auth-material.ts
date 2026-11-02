import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";

import type { GuestOpaqueCredentialHandleV1 } from "../../../../src/guest/runtime/adapter.js";

export const CODEX_CONTROLLER_HOME = "/run/alma/codex-controller-home" as const;

/** Provider-private auth.json materializer. No secret crosses its public errors. */
export class CodexAuthMaterialGuardV1 {
  readonly #home: string;
  readonly #authPath: string;
  #installed = false;

  public constructor(home: string, workspaceRoot: string) {
    assertAbsolutePath(home);
    assertDisjoint(home, workspaceRoot);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(home);
    if (canonical !== resolve(home)) throw new CodexAuthMaterialError("invalid_home");
    assertPrivateDirectory(canonical);
    if (readdirSync(canonical).length !== 0) {
      throw new CodexAuthMaterialError("home_not_fresh");
    }
    this.#home = canonical;
    this.#authPath = `${canonical}/auth.json`;
  }

  public get home(): string {
    return this.#home;
  }

  public install(credential: GuestOpaqueCredentialHandleV1 | null): void {
    if (this.#installed) throw new CodexAuthMaterialError("already_installed");
    if (credential === null || credential.byteLength === 0) {
      throw new CodexAuthMaterialError("credential_required");
    }
    if (readdirSync(this.#home).length !== 0) {
      throw new CodexAuthMaterialError("home_not_fresh");
    }
    const bytes = credential.consume();
    let descriptor: number | undefined;
    try {
      if (bytes.byteLength !== credential.byteLength || bytes.byteLength === 0) {
        throw new CodexAuthMaterialError("credential_invalid");
      }
      descriptor = openSync(
        this.#authPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw new CodexAuthMaterialError("write_failed");
        offset += written;
      }
      fsyncSync(descriptor);
      const stat = fstatSync(descriptor);
      if (stat.size !== bytes.byteLength) throw new CodexAuthMaterialError("write_failed");
      closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(this.#home);
      this.#installed = true;
      this.verifyBeforeTurn();
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        if (existsSync(this.#authPath)) unlinkSync(this.#authPath);
      } catch {
        // SuperBox destruction remains authoritative for an untrusted partial.
      }
      throw error instanceof CodexAuthMaterialError
        ? error
        : new CodexAuthMaterialError("write_failed");
    } finally {
      bytes.fill(0);
    }
  }

  /** Required after initialize/account/thread receipts and before turn/start. */
  public verifyBeforeTurn(): void {
    if (!this.#installed) throw new CodexAuthMaterialError("credential_required");
    try {
      assertPrivateDirectory(this.#home);
      const stat = lstatSync(this.#authPath);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || stat.size <= 0
        || (stat.mode & 0o777) !== 0o600
        || !ownedByCurrentUser(stat.uid)
        || realpathSync(this.#authPath) !== this.#authPath
      ) {
        throw new CodexAuthMaterialError("auth_file_untrusted");
      }
    } catch (error) {
      if (error instanceof CodexAuthMaterialError) throw error;
      throw new CodexAuthMaterialError("auth_file_untrusted");
    }
  }

  /** Removes the only filesystem credential before any untrusted prompt is released. */
  public removeBeforeTurn(): void {
    this.#removeInstalledCredential();
  }

  /** Best-effort defense in depth; SuperBox destruction remains authoritative. */
  public removeAfterProcessExit(): void {
    this.#removeInstalledCredential();
  }

  #removeInstalledCredential(): void {
    if (!this.#installed) return;
    if (!existsSync(this.#authPath)) {
      this.#installed = false;
      return;
    }
    try {
      this.verifyBeforeTurn();
      unlinkSync(this.#authPath);
      syncDirectory(this.#home);
      this.#installed = false;
    } catch (error) {
      if (error instanceof CodexAuthMaterialError) throw error;
      throw new CodexAuthMaterialError("auth_file_untrusted");
    }
  }
}

export type CodexAuthMaterialErrorCode =
  | "invalid_home"
  | "home_not_fresh"
  | "credential_required"
  | "credential_invalid"
  | "already_installed"
  | "write_failed"
  | "auth_file_untrusted";

export class CodexAuthMaterialError extends Error {
  public constructor(public readonly code: CodexAuthMaterialErrorCode) {
    super("Codex authentication material is unavailable or untrusted");
    this.name = "CodexAuthMaterialError";
  }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || !ownedByCurrentUser(stat.uid)
    || realpathSync(path) !== path
  ) {
    throw new CodexAuthMaterialError("invalid_home");
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertDisjoint(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
    throw new CodexAuthMaterialError("invalid_home");
  }
}

function assertAbsolutePath(value: string): void {
  if (
    !value.startsWith("/")
    || value === "/"
    || value.endsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part, index) =>
      index > 0 && (part.length === 0 || part === "." || part === "..")
    )
  ) {
    throw new CodexAuthMaterialError("invalid_home");
  }
}
