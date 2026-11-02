import { randomUUID } from "node:crypto";
import {
  AuthOperationError, MAX_WIRE_BYTES, cancelled, challengeSchema, inputFrameSchema,
  outputFrameSchema, providerIDSchema, type AuthHello,
} from "./protocol.js";
import type { AuthDriver, AuthDriverResult } from "./driver.js";
import { assertAuthGuestSecurity } from "./guest-security.js";

/** Auth appliance only: this endpoint has no prompt, turn, tool or attempt request. */
async function main(): Promise<void> {
  const providerID = providerIDSchema.parse(process.argv[2]);
  assertAuthGuestSecurity(providerID);
  const abort = new AbortController();
  let phase: "hello" | "credential" | "running" | "terminal" = "hello";
  let hello: AuthHello | undefined;
  let credential: Uint8Array | null = null;
  let malformed = false;
  let buffer = Buffer.alloc(0);
  let resolveStart!: () => void;
  let rejectStart!: (error: Error) => void;
  const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  let secret: { id: string; resolve(value: Uint8Array): void; reject(error: Error): void } | null = null;
  const onAbort = (): void => { rejectStart(cancelled()); secret?.reject(cancelled()); secret = null; };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  const write = async (value: unknown): Promise<void> => {
    const frame = outputFrameSchema.parse(value);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve());
    });
  };
  const failProtocol = (): void => { malformed = true; abort.abort(); };
  process.stdin.on("data", (chunk: Buffer) => {
    if (phase === "terminal") return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      if (end > MAX_WIRE_BYTES) { failProtocol(); return; }
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const frame = inputFrameSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (frame.type === "cancel") { abort.abort(); continue; }
        if (phase === "hello" && frame.type === "hello" && frame.providerID === providerID) {
          hello = frame;
          phase = "credential";
          void write({ ...frame, type: "ready" }).catch(failProtocol);
        } else if (phase === "credential" && frame.type === "credential") {
          credential = frame.data === null ? null : Buffer.from(frame.data, "base64");
          phase = "running";
          resolveStart();
        } else if (phase === "running" && frame.type === "input" && secret?.id === frame.challengeID) {
          const pending = secret;
          secret = null;
          pending.resolve(Buffer.from(frame.data, "base64"));
        } else { failProtocol(); return; }
      } catch { failProtocol(); return; }
      finally { line.fill(0); }
    }
    if (buffer.byteLength > MAX_WIRE_BYTES) failProtocol();
  });
  process.stdin.on("end", () => abort.abort());
  process.stdin.on("error", failProtocol);
  let result: AuthDriverResult | undefined;
  try {
    await start;
    if (abort.signal.aborted || !hello) throw cancelled();
    // Computed import keeps Provider code out of the Host package and loads only
    // the selected appliance's build-time bundled Adapter.
    const driverPath = `../../providers/${providerID}/adapter/src/auth-driver.js`;
    const module = await import(driverPath) as { runAuthDriver: AuthDriver };
    result = await module.runAuthDriver({
      providerID, kind: hello.kind, credential, signal: abort.signal,
      challenge: async (value) => {
        if (abort.signal.aborted) throw cancelled();
        if (hello?.kind !== "authenticate" || secret !== null) throw new AuthOperationError("protocol");
        const challenge = challengeSchema.parse(value);
        const challengeID = randomUUID();
        if (challenge.kind === "device_code") {
          await write({ type: "challenge", challengeID, challenge });
          return null;
        }
        const input = new Promise<Uint8Array>((resolve, reject) => { secret = { id: challengeID, resolve, reject }; });
        await write({ type: "challenge", challengeID, challenge });
        return input;
      },
    });
    if (abort.signal.aborted) throw cancelled();
    if (result.credential !== null) {
      await write({ type: "credential", data: Buffer.from(result.credential).toString("base64") });
    }
    phase = "terminal";
    await write({
      type: "result", state: result.state, account: result.account,
      catalog: result.catalog, catalogUnavailable: result.catalogUnavailable,
      accountUsage: result.accountUsage, accountUsageUnavailable: result.accountUsageUnavailable,
    });
  } catch (error) {
    phase = "terminal";
    await write(malformed ? { type: "failure", code: "protocol" }
      : error instanceof AuthOperationError ? { type: "failure", code: error.code }
        : abort.signal.aborted ? { type: "cancelled" } : { type: "failure", code: "protocol" });
  } finally {
    (credential as Uint8Array | null)?.fill(0);
    result?.credential?.fill(0);
    buffer.fill(0);
    abort.signal.removeEventListener("abort", onAbort);
  }
}

// No Provider error, diagnostic, credential or URL is printed to the serial log.
void main().then(() => process.exit(0), () => process.exit(1));
