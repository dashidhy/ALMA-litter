export interface DedicatedProviderChildExitV1 {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reaped: boolean;
}

/** Trusted bootstrap process; it must load no Provider code before `start`. */
export interface DedicatedProviderChildV1 {
  readonly pid: number;
  readonly output: AsyncIterable<Uint8Array>;
  writeControl(bytes: Uint8Array): void | Promise<void>;
  writeCredential(bytes: Uint8Array): void | Promise<void>;
  closeCredential(): void | Promise<void>;
  /** Revokes parent-to-child channels without destroying observable stdout. */
  revokeInput(): void | Promise<void>;
  /** Releases the stdout descriptor only after it has reached verified EOF. */
  releaseOutput(): void | Promise<void>;
  terminate(signal: "SIGTERM"): void | Promise<void>;
  waitForExit(timeoutMilliseconds: number): Promise<DedicatedProviderChildExitV1>;
}

/** Preconfigured with one fixed bootstrap executable and a closed environment. */
export interface DedicatedProviderSpawnPortV1 {
  spawnBootstrap(): Promise<DedicatedProviderChildV1>;
}

export interface DedicatedProviderCgroupLeaseV1 {
  attachBootstrapPID(pid: number): void | Promise<void>;
  /** Proves the blocked bootstrap PID is a member and the leaf is populated. */
  verifyBootstrapPlacement(pid: number): void | Promise<void>;
  killAll(): void | Promise<void>;
  isPopulated(): boolean | Promise<boolean>;
  remove(): void | Promise<void>;
}

export interface DedicatedProviderCgroupPortV1 {
  create(scopeID: string): Promise<DedicatedProviderCgroupLeaseV1>;
}

export interface DedicatedProviderTimePortV1 {
  nowMilliseconds(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemDedicatedProviderTimePortV1: DedicatedProviderTimePortV1 = Object.freeze({
  nowMilliseconds: () => Date.now(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  }),
});
