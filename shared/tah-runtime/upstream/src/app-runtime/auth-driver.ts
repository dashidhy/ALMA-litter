import { randomUUID } from "node:crypto";
import { AuthOperationError, MAX_WIRE_BYTES, cancelled, outputFrameSchema, type AuthOutputFrame } from "../auth-prototype/protocol.js";
import type { AuthDriver, AuthDriverResult } from "../auth-prototype/driver.js";
import type { SuperBoxDuplexChildTransportV1 } from "../superbox/process-client.js";
import { AppBridgeError } from "./bridge.js";

/** Host-owned VM channel, without spawning a helper or loading a Provider on macOS. */
export function createServiceAuthDriver(
  open: (providerID: string, operationID: string) => Promise<SuperBoxDuplexChildTransportV1>,
  timeoutMs = 15 * 60_000,
): AuthDriver {
  return async context => {
    if (context.signal.aborted) throw cancelled();
    const operationID = randomUUID();
    let transport: SuperBoxDuplexChildTransportV1;
    try { transport = await open(context.providerID, operationID); }
    catch (error) { throw new AuthOperationError(error instanceof AppBridgeError && error.code === "integrity_locked" ? "cleanup" : "unavailable"); }
    const exit = transport.waitForExit();
    void exit.catch(() => {});
    let credential: Uint8Array | null = null;
    let buffer = Buffer.alloc(0);
    let totalBytes = 0;
    let phase: "ready" | "running" | "credential" | "terminal" = "ready";
    let result: Extract<AuthOutputFrame, { type: "result" }> | null = null;
    let failure: AuthOperationError | null = null;
    let finished = false;
    let rejectInterrupted!: (error: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => {});
    const interrupt = (error: unknown) => { rejectInterrupted(error); void Promise.resolve(transport.destroy()).catch(() => {}); };
    const onAbort = () => interrupt(cancelled());
    context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => interrupt(new AuthOperationError("timeout")), timeoutMs);
    const send = async (frame: unknown) => {
      const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
      try { await Promise.race([Promise.resolve(transport.write(bytes)), interrupted]); }
      finally { bytes.fill(0); }
    };
    try {
      if (context.signal.aborted) throw cancelled();
      await send({ type: "hello", version: 1, operationID, providerID: context.providerID, kind: context.kind });
      const iterator = transport.stdout[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), interrupted]);
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > 2 * 1024 * 1024) throw new AuthOperationError("protocol");
        buffer = Buffer.concat([buffer, next.value]);
        while (true) {
          const end = buffer.indexOf(10);
          if (end < 0) break;
          if (end > MAX_WIRE_BYTES || phase === "terminal") throw new AuthOperationError("protocol");
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          let frame: AuthOutputFrame;
          try { frame = outputFrameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))); }
          finally { line.fill(0); }
          if (frame.type === "ready" && phase === "ready") {
            if (frame.operationID !== operationID || frame.providerID !== context.providerID || frame.kind !== context.kind) throw new AuthOperationError("protocol");
            phase = "running";
            await send({ type: "credential", data: context.credential === null ? null : Buffer.from(context.credential).toString("base64") });
          } else if (frame.type === "challenge" && phase === "running" && context.kind === "authenticate") {
            const challenge = context.challenge(frame.challenge).then(input => {
              if (finished || context.signal.aborted) { input?.fill(0); throw cancelled(); }
              return input;
            });
            const input = await Promise.race([challenge, interrupted]);
            try {
              if (frame.challenge.kind === "secret") {
                if (!input) throw new AuthOperationError("protocol");
                await send({ type: "input", challengeID: frame.challengeID, data: Buffer.from(input).toString("base64") });
              }
            } finally { input?.fill(0); }
          } else if (frame.type === "credential" && phase === "running") {
            credential = Buffer.from(frame.data, "base64"); phase = "credential";
          } else if (frame.type === "result" && (phase === "running" || phase === "credential")) {
            if (frame.state === "invalid" && frame.catalog !== null) throw new AuthOperationError("protocol");
            result = frame; phase = "terminal";
          } else if (frame.type === "failure" && phase !== "ready") {
            failure = new AuthOperationError(frame.code); phase = "terminal";
          } else if (frame.type === "cancelled" && context.signal.aborted) {
            phase = "terminal";
          } else { throw new AuthOperationError("protocol"); }
        }
        if (buffer.length > MAX_WIRE_BYTES) throw new AuthOperationError("protocol");
      }
      const receipt = await Promise.race([exit, interrupted]);
      if (!receipt.destroyed) throw new AuthOperationError("cleanup");
      if (context.signal.aborted) throw cancelled();
      if (failure) throw failure;
      if (receipt.exitCode !== 0) throw new AuthOperationError("unavailable");
      if (phase !== "terminal" || result === null || buffer.length !== 0) throw new AuthOperationError("protocol");
      const returned: AuthDriverResult = { state: result.state, credential, account: result.account,
        catalog: result.catalog, catalogUnavailable: result.catalogUnavailable,
        accountUsage: result.accountUsage, accountUsageUnavailable: result.accountUsageUnavailable };
      credential = null;
      return returned;
    } catch (error) {
      try {
        await transport.destroy();
        if (!(await exit).destroyed) throw new Error("unconfirmed cleanup");
      } catch { throw new AuthOperationError("cleanup"); }
      if (context.signal.aborted) throw cancelled();
      if (error instanceof AuthOperationError || error instanceof DOMException) throw error;
      throw new AuthOperationError("protocol");
    } finally {
      finished = true;
      clearTimeout(timer); context.signal.removeEventListener("abort", onAbort);
      (credential as Uint8Array | null)?.fill(0); buffer.fill(0);
    }
  };
}
