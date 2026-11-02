import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AuthOperationError, MAX_WIRE_BYTES, cancelled, outputFrameSchema, type AuthOutputFrame, type AuthProviderID } from "./protocol.js";
import type { AuthDriver, AuthDriverResult } from "./driver.js";

export interface VMAuthOptions {
  readonly helperPath: string;
  manifestForProvider(providerID: AuthProviderID, signal: AbortSignal): Promise<string>;
  readonly timeoutMs?: number;
}

/** Returns only after the Host helper confirms whole-VM destruction. */
export function createVMAuthDriver(options: VMAuthOptions): AuthDriver {
  return async (context) => {
    const manifest = await options.manifestForProvider(context.providerID, context.signal);
    if (context.signal.aborted) throw cancelled();
    const operationID = randomUUID();
    const hello = { type: "hello", version: 1, operationID, providerID: context.providerID, kind: context.kind };
    const child = spawn(options.helperPath, [manifest], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
    });
    let phase: "ready" | "running" | "credential" | "terminal" = "ready";
    let received: Extract<AuthOutputFrame, { type: "result" }> | null = null;
    let credential: Uint8Array | null = null;
    let failure: AuthOperationError | null = null;
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let pendingInput = false;
    let spawned = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (frame: unknown): void => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    const stop = (): void => {
      send({ type: "cancel" });
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 8_000);
    };
    const fail = (code: "protocol" | "timeout"): void => {
      failure ??= new AuthOperationError(code);
      stop();
    };
    const onAbort = (): void => stop();
    context.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => fail("timeout"), options.timeoutMs ?? 15 * 60_000);
    child.on("spawn", () => { spawned = true; send(hello); });
    child.stdin.on("error", () => { /* Exit and terminal receipts decide the result. */ });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > 2 * 1024 * 1024) { fail("protocol"); return; }
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const end = buffer.indexOf(10);
        if (end < 0) break;
        if (end > MAX_WIRE_BYTES) { fail("protocol"); return; }
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        try {
          const frame = outputFrameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
          if (phase === "terminal") throw new AuthOperationError("protocol");
          if (frame.type === "ready" && phase === "ready") {
            if (frame.operationID !== operationID || frame.providerID !== context.providerID
              || frame.kind !== context.kind) throw new AuthOperationError("protocol");
            phase = "running";
            send({ type: "credential", data: context.credential === null ? null : Buffer.from(context.credential).toString("base64") });
          } else if (frame.type === "challenge" && phase === "running" && !pendingInput && context.kind === "authenticate") {
            pendingInput = frame.challenge.kind === "secret";
            void context.challenge(frame.challenge).then((input) => {
              try {
                if (context.signal.aborted || phase !== "running") return;
                if (frame.challenge.kind === "secret") {
                  if (input === null) { fail("protocol"); return; }
                  pendingInput = false;
                  send({ type: "input", challengeID: frame.challengeID, data: Buffer.from(input).toString("base64") });
                }
              } finally { input?.fill(0); }
            }).catch(() => { if (!context.signal.aborted) fail("protocol"); });
          } else if (frame.type === "credential" && phase === "running" && !pendingInput) {
            credential = Buffer.from(frame.data, "base64");
            phase = "credential";
          } else if (frame.type === "result" && (phase === "running" || phase === "credential") && !pendingInput) {
            if (frame.state === "invalid" && frame.catalog !== null) throw new AuthOperationError("protocol");
            received = frame;
            phase = "terminal";
          } else if (frame.type === "failure" && phase !== "ready") {
            failure = new AuthOperationError(frame.code);
            phase = "terminal";
          } else if (frame.type === "cancelled" && context.signal.aborted) {
            phase = "terminal";
          } else { throw new AuthOperationError("protocol"); }
        } catch { fail("protocol"); }
        finally { line.fill(0); }
      }
      if (buffer.byteLength > MAX_WIRE_BYTES) fail("protocol");
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("error", () => { failure ??= new AuthOperationError("unavailable"); });
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      // Only 0 and 1 attest cleanup. SIGKILL or a crashed helper cannot attest it.
      if (spawned && (exit.signal !== null || (exit.code !== 0 && exit.code !== 1))) throw new AuthOperationError("cleanup");
      if ((failure as AuthOperationError | null)?.code === "cleanup") throw failure;
      if (context.signal.aborted) throw cancelled();
      if (failure !== null) throw failure;
      if (exit.code !== 0) throw new AuthOperationError("unavailable");
      if (buffer.byteLength !== 0 || (phase as string) !== "terminal" || received === null) throw new AuthOperationError("protocol");
      const result = received as Extract<AuthOutputFrame, { type: "result" }>;
      const returned: AuthDriverResult = {
        state: result.state, credential, account: result.account,
        catalog: result.catalog, catalogUnavailable: result.catalogUnavailable,
        accountUsage: result.accountUsage, accountUsageUnavailable: result.accountUsageUnavailable,
      };
      credential = null;
      return returned;
    } finally {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      context.signal.removeEventListener("abort", onAbort);
      (credential as Uint8Array | null)?.fill(0);
      buffer.fill(0);
    }
  };
}
