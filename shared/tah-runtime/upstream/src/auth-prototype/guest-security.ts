import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { AuthProviderID } from "./protocol.js";

const AUTH_UID = 1000;
const AUTH_GID = 1000;
const COMMON_PRIVATE_DIRECTORIES = Object.freeze([
  "/run/alma/auth-home",
  "/run/alma/auth-tmp",
  "/run/alma/auth-config",
  "/workspace/attempt",
]);
const QODER_PRIVATE_DIRECTORIES = Object.freeze([
  "/run/alma/qoder-sdk-host-credential-tmp",
  "/run/alma/qoder-worker-state",
  "/run/alma/qoder-worker-state/home",
  "/run/alma/qoder-worker-state/tmp",
  "/run/alma/qoder-worker-state/config",
]);

export interface AuthGuestSecuritySnapshot {
  readonly uid: number;
  readonly euid: number;
  readonly gid: number;
  readonly egid: number;
  readonly groups: readonly number[];
  readonly procStatus: string;
  readonly directories: Readonly<Record<string, Readonly<{
    directory: boolean;
    symbolicLink: boolean;
    uid: number;
    gid: number;
    mode: number;
    canonical: string;
  }>>>;
}

/** Fail before reading a credential unless the root bootstrap really dropped privilege. */
export function assertAuthGuestSecurity(
  providerID: AuthProviderID,
  snapshot: AuthGuestSecuritySnapshot = inspectAuthGuestSecurity(providerID),
): void {
  if (snapshot.uid !== AUTH_UID || snapshot.euid !== AUTH_UID
    || snapshot.gid !== AUTH_GID || snapshot.egid !== AUTH_GID
    || snapshot.groups.length === 0 || snapshot.groups.some((group) => group !== AUTH_GID)) {
    throw new TypeError("Auth Guest runtime identity is invalid");
  }
  const status = snapshot.procStatus;
  if (!/^Uid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status)
    || !/^Gid:\s+1000\s+1000\s+1000\s+1000$/mu.test(status)
    || !/^NoNewPrivs:\s+1$/mu.test(status)
    || !/^CapInh:\s+0+$/mu.test(status)
    || !/^CapPrm:\s+0+$/mu.test(status)
    || !/^CapEff:\s+0+$/mu.test(status)
    || !/^CapAmb:\s+0+$/mu.test(status)) {
    throw new TypeError("Auth Guest process privilege is invalid");
  }
  for (const path of requiredDirectories(providerID)) {
    const directory = snapshot.directories[path];
    if (directory === undefined || !directory.directory || directory.symbolicLink
      || directory.uid !== AUTH_UID || directory.gid !== AUTH_GID
      || (directory.mode & 0o777) !== 0o700 || directory.canonical !== path) {
      throw new TypeError("Auth Guest private directory is invalid");
    }
  }
}

function inspectAuthGuestSecurity(providerID: AuthProviderID): AuthGuestSecuritySnapshot {
  if (process.getuid === undefined || process.geteuid === undefined
    || process.getgid === undefined || process.getegid === undefined
    || process.getgroups === undefined) {
    throw new TypeError("Auth Guest does not expose Unix process identity");
  }
  const directories: Record<string, AuthGuestSecuritySnapshot["directories"][string]> = {};
  for (const path of requiredDirectories(providerID)) {
    const stat = lstatSync(path);
    directories[path] = Object.freeze({
      directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink(),
      uid: stat.uid, gid: stat.gid, mode: stat.mode, canonical: realpathSync(path),
    });
  }
  return Object.freeze({
    uid: process.getuid(), euid: process.geteuid(),
    gid: process.getgid(), egid: process.getegid(), groups: Object.freeze(process.getgroups()),
    procStatus: readFileSync("/proc/self/status", "utf8"), directories: Object.freeze(directories),
  });
}

function requiredDirectories(providerID: AuthProviderID): readonly string[] {
  return providerID === "qoder"
    ? [...COMMON_PRIVATE_DIRECTORIES, ...QODER_PRIVATE_DIRECTORIES]
    : COMMON_PRIVATE_DIRECTORIES;
}
