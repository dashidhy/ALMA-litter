// Model-free P1 fixture. Never included in a production runtime closure.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { serveAppRuntime } from "../app-runtime/stdio.js";
import { openServiceSuperBoxTransport } from "../app-runtime/superbox-transport.js";
import { runSuperBoxProcessOperationV1 } from "../superbox/process-client.js";
import type { FrozenAttemptV1 } from "../contract/attempt.js";
import { ServiceJournal } from "../app-runtime/journal.js";
import { DurableTahPersistence } from "../app-runtime/durable-persistence.js";
import { persistenceFixture } from "./persistence-fixture.js";

const persistedActionID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

serveAppRuntime(bridge => ({
  "qualification.persistenceWrite": async () => {
    const persistence = new DurableTahPersistence(new ServiceJournal(bridge), () => "qualification/transcript");
    const fixture = persistenceFixture(persistedActionID);
    await persistence.commitProposal(fixture.proposal);
    await persistence.publishRevision(fixture.publication);
    return { saved: true, accepted: (await persistence.acceptedPublications(persistedActionID)).length };
  },
  "qualification.persistenceRead": async () => {
    const persistence = new DurableTahPersistence(new ServiceJournal(bridge), () => "qualification/transcript");
    const accepted = await persistence.acceptedPublications(persistedActionID);
    if (accepted.length !== 1 || accepted[0]?.outcome.entries.length !== 2) throw new Error("durable outcome was not restored");
    const receipt = await persistence.publishRevision(accepted[0]);
    return { restored: true, accepted: accepted.length, replayed: receipt.commitID.startsWith("publication/") };
  },
  "runtime.inspect": async () => ({ protocolVersion: 1, runtime: "tah-v4.2-qualification",
    jitless: process.execArgv.includes("--jitless"), nodeVersion: process.versions.node, architecture: process.arch }),
  "qualification.cancel": async value => {
    z.strictObject({}).parse(value);
    const transport = await openServiceSuperBoxTransport(bridge, "fixture", randomUUID());
    const exit = transport.waitForExit();
    // Cancellation with an open, otherwise idle Guest byte channel.
    await transport.destroy();
    const receipt = await exit;
    if (!receipt.destroyed || receipt.exitCode === 0) throw new Error("cancellation did not destroy VM");
    return { destroyed: true, candidateFiles: 0, terminal: "cancelled" };
  },
  "qualification.hold": async value => {
    z.strictObject({}).parse(value);
    await openServiceSuperBoxTransport(bridge, "fixture", randomUUID());
    return { vmReady: true };
  },
  "qualification.crash": async value => {
    z.strictObject({}).parse(value);
    await openServiceSuperBoxTransport(bridge, "fixture", randomUUID());
    // The fixture deliberately kills only itself. Swift must still own/destroy VM.
    process.kill(process.pid, "SIGKILL");
    throw new Error("unreachable");
  },
  "qualification.run": async value => {
    const options = z.strictObject({ network: z.boolean().optional() }).parse(value);
    const operationID = randomUUID();
    const material = Buffer.from(options.network ? "ALMA NAT/TLS qualification input.\n" : "ALMA shared SuperBox wire input.\n");
    const attempt: FrozenAttemptV1 = {
      contractVersion: 1, attemptID: randomUUID(), providerID: "fixture", role: "actor",
      inference: { modelID: "fixture-model", reasoningEffortID: null },
      prompt: [{ authority: "tah_instruction", text: "Create the exact two-file fixture outcome from the copied input." }],
      workspace: { materials: [{ relativePath: "inbox/source.txt", mediaType: "text/plain", byteLength: material.length,
        sha256: createHash("sha256").update(material).digest("hex") }], candidateSeeds: [], writableRoots: ["outbox/revision_v0"] },
      responseExpectation: { kind: "workspace_outcome", contractID: "structured_notes/fixture-v1", maximumFinalMessageUTF8Bytes: 4096 },
      requiredAbilities: ["prompt.inline_text", "workspace.entries.list", "workspace.text.read", "workspace.text.search", "workspace.text.write", "workspace.text.edit"],
    };
    const transport = await openServiceSuperBoxTransport(bridge, "fixture", operationID);
    const result = await runSuperBoxProcessOperationV1({ operationID, attempt, materialBytes: new Map([["inbox/source.txt", material]]),
      transport, timeoutMilliseconds: 45_000, exitTimeoutMilliseconds: 20_000 });
    const exit = await transport.waitForExit();
    if (options.network) {
      if (result.terminal.kind !== "end_turn" || !exit.destroyed || exit.exitCode !== 0 || result.quarantinedCandidates.size !== 2) {
        throw new Error("network fixture did not reach destroyed end_turn");
      }
      const network = z.strictObject({ httpsSucceeded: z.boolean(), emptyTrustRejected: z.boolean(), failureCode: z.string().regex(/^[A-Z_]{1,64}$/u).nullable() })
        .parse(JSON.parse(Buffer.from(result.quarantinedCandidates.get("outbox/revision_v0/structured-notes.md") ?? []).toString("utf8")));
      return { destroyed: true, candidateFiles: 2, ...network };
    }
    const expected = new Map([
      ["outbox/revision_v0/structured-notes.md", `# Shared Wire Fixture\n\n${material.toString("utf8")}`],
      ["outbox/revision_v0/suspicious-asr-terms.md", "# Suspicious ASR Terms\n\nNone.\n"],
    ]);
    if (result.terminal.kind !== "end_turn" || !exit.destroyed || exit.exitCode !== 0
      || result.quarantinedCandidates.size !== expected.size
      || [...expected].some(([path, text]) => !Buffer.from(result.quarantinedCandidates.get(path) ?? []).equals(Buffer.from(text)))) {
      throw new Error("fixture outcome mismatch");
    }
    return { destroyed: true, candidateFiles: result.quarantinedCandidates.size, terminal: result.terminal.kind };
  },
}));
