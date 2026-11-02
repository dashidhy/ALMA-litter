import { describe, it, expect, afterEach } from "../../../../ALMA/app/TAH/node_modules/vitest/dist/index.js";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createPhonePort, PhonePortError } from "./phone-port.js";
import type { RunCommand } from "./phone-port.js";
import { loadFixture, projectPhonePayload } from "./controller.js";
import { buildRawGuardianAttemptV1, buildActorAttemptV1 } from "../../../../ALMA/app/TAH/src/framework/attempt-builders.js";
import { projectNativePromptChannelsV1 } from "../../../../ALMA/app/TAH/src/guest/adapter-kit/prompt-envelope.js";
import { NormalizedEventLedgerV1 } from "../../../../ALMA/app/TAH/src/contract/events.js";
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await fs.rm(p, { recursive: true, force: true }); });
const hash = (s: Uint8Array) => createHash("sha256").update(s).digest("hex");
async function harness(mode = "ok") {
  const base = new URL(".phone-test-cache/fixtures/", import.meta.url);
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(new URL("run-", base).pathname); roots.push(root);
  const profileFile = join(root, "qualification-profile.json"), profile = "b".repeat(64);
  await fs.writeFile(profileFile, JSON.stringify({ digest: mode === "profile" ? "c".repeat(64) : profile, inputs: { schema: "alma.phone.qualification-build/v1" } }));
  const inspection = { validChatGPT: true, models: [{ id: "fixture", model: "fixture-model", displayName: "Fixture",
    isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"],
    effortDescriptions: [{ handle: "low", displayName: "Low" }] }],
    rawQuotaResponse: { rateLimits: { limitId: "codex", primary: { usedPercent: 5, windowDurationMins: 300 } } } };
  const calls: string[][] = []; let challenge = "", inbound: any, phase = "inspection", processChecks = 0;
  const candidate = new Map<string, Buffer>();
  const command: RunCommand = async args => {
    calls.push(args); expect(args).not.toContain("--native"); expect(args).not.toContain("--kill-existing");
    if (mode === "rsd") throw new PhonePortError("rsd_disconnected");
    if (args.includes("list-processes")) { processChecks++; return "[]"; }
    if (args.includes("launch-application")) {
      challenge = args.at(-1)!; phase = args.includes("--run-tah-attempt") ? "attempt" : "inspection";
      return JSON.stringify({ processToken: { processIdentifier: 4242 } });
    }
    if (args[1] === "push") { inbound = JSON.parse(await fs.readFile(args.at(-2)!, "utf8")); return ""; }
    const target = args.at(-1)!;
    if (args[1] === "pull" && args.at(-2) === "Documents/tah-observation.json") {
      let observation: any = { outcome: "observed", actualAccountFingerprint: "a".repeat(64), inspection };
      if (phase === "attempt") {
        const a = JSON.parse(inbound.attemptJSON), root = a.workspace.writableRoots[0];
        const finalText = root ? "Done." : '{"decision":"ALLOW","reasonCodes":[],"explanation":"Synthetic fixture."}';
        candidate.clear();
        if (root) for (const name of ["structured-notes.md", "suspicious-asr-terms.md"]) candidate.set(`${root}/${name}`, Buffer.from("# Fixture\n"));
        const entries: any[] = root ? [{ relativePath: root, kind: "directory", byteLength: null }] : [];
        for (const [relativePath, b] of candidate) entries.push({ relativePath, kind: "file", byteLength: b.length, sha256: hash(b), base64: b.toString("base64") });
        const item = { id: "final", type: "agentMessage", phase: "final_answer", text: finalText };
        observation = { outcome: "observed", identity: { runID: inbound.runID, challenge, attemptID: a.attemptID,
          attemptSHA256: inbound.attemptSHA256, expectedAccountFingerprint: "a".repeat(64), actualAccountFingerprint: "a".repeat(64), profileDigest: profile, role: a.role }, inspection,
          threadReceipt: { threadID: "thread", model: "fixture-model", reasoningEffort: mode === "native-default" ? null : "low", ephemeral: true, cwd: `/workspace/attempts/${a.attemptID}/view` },
          turnReceipt: { turnID: "turn", status: "inProgress", errorPresent: false },
          terminal: { status: "completed", errorPresent: false, finalText }, quiescenceObserved: true,
          notifications: [ { kind: "notification", method: "item/started", params: { threadId: "thread", turnId: "turn", item } },
            { kind: "notification", method: "item/completed", params: { threadId: "thread", turnId: "turn", item } },
            { kind: "notification", method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [item] } } } ],
          snapshot: { immutableInputsUnchanged: true, candidateEntries: entries, totalCandidateBytes: [...candidate.values()].reduce((n,b) => n+b.length,0) } };
      }
      const record = { schema: "alma.phone-observation/v1", pid: mode === "pid" ? 9999 : 4242, runID: challenge, kind: phase,
        profileDigest: profile, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        requiresExternalProcessExitVerification: true, observation };
      if (mode === "quota") record.observation.inspection.rawQuotaResponse = {};
      await fs.writeFile(target, JSON.stringify(record)); return "";
    }
    if (args[1] === "pull") {
      expect(processChecks).toBeGreaterThanOrEqual(6); // baseline + two absent samples for each process
      const view = join(target, "view"); await fs.mkdir(view);
      for (const file of [...inbound.inputFiles, ...[...candidate].map(([relativePath,b]) => ({ relativePath, base64: b.toString("base64") }))]) {
        const path = join(view, file.relativePath); await fs.mkdir(join(path, ".."), { recursive: true });
        await fs.writeFile(path, mode === "tamper" ? "altered" : Buffer.from(file.base64, "base64"));
      }
      return "";
    }
    throw new Error("unexpected command");
  };
  return { port: createPhonePort({ workRoot: root, profileFile, expectedProfileDigest: profile, command, sleep: async () => {} }), calls };
}
async function request(binding: any, actor = false, effort: string | null = "low") {
  const f = await loadFixture(), common = { attemptID: randomUUID(), providerID: "codex", inference: { modelID: "fixture-model", reasoningEffortID: effort }, rawTranscript: f.rawTranscript };
  const built = actor ? buildActorAttemptV1({ ...common, actorPromptTemplate: f.resources.actorPromptTemplate,
    revisionIndex: 0, actionInstructions: f.actionDefinition.renderActionInstructions("en"), outcomeContract: f.actionDefinition.outcomeContract,
    extraInstructionsMarkdown: "# Extra Instructions\n\n## revision v0\n\nN/A\n", webEnabled: false, acceptedRevisions: [] })
    : buildRawGuardianAttemptV1({ ...common, guardianPrompt: f.resources.rawGuardianPrompt, safetyPolicy: f.resources.safetyPolicy });
  return { runID: randomUUID(), binding, built, payload: projectPhonePayload(built), channels: projectNativePromptChannelsV1(built.attempt.prompt) };
}
describe("mocked subprocess only; original account/event normalization", () => {
  it("preserves native-default null effort while rejecting a missing explicitly requested effort", async () => {
    const h = await harness("native-default"), b = await h.port.inspect(), r = await request(b,true,null);
    const token = await h.port.runFresh(r,async()=>{});
    expect((await h.port.admitReaped(token,r)).result.terminal.kind).toBe("end_turn");
    const strict = await harness("native-default"), binding = await strict.port.inspect();
    await expect(strict.port.runFresh(await request(binding,true,"low"),async()=>{})).rejects.toThrow("thread_receipt_mismatch");
  });
  it("derives inspection after two successful PID-absent samples", async () => {
    const h = await harness(), b = await h.port.inspect();
    expect(b.authorization.inspection?.state).toBe("succeeded");
    expect(h.calls.filter(a => a.includes("list-processes"))).toHaveLength(3);
    expect(JSON.stringify(b)).not.toContain("rawQuotaResponse");
  });
  it.each([false,true])("admits real-shaped events and post-exit physical files (actor=%s)", async actor => {
    const h = await harness(), b = await h.port.inspect(), r = await request(b, actor);
    const ledger = new NormalizedEventLedgerV1(r.built.attempt.attemptID);
    const token = await h.port.runFresh(r, async e => ledger.observe(e));
    await expect(h.port.admitReaped({}, r)).rejects.toThrow();
    const admitted = await h.port.admitReaped(token, r); ledger.assertTerminal(admitted.result.terminal);
    expect(admitted.result.candidateFiles.size).toBe(actor ? 2 : 0);
    await expect(h.port.admitReaped(token, r)).rejects.toThrow();
  });
  it.each(["quota","pid"])("fails closed for %s evidence", async mode => {
    const h = await harness(mode); await expect(h.port.inspect()).rejects.toThrow();
    await expect(h.port.inspect()).rejects.toThrow("port_busy_or_locked");
    expect(h.calls.filter(a => a.includes("launch-application"))).toHaveLength(1);
  });
  it("rejects input tampering despite a successful native snapshot flag", async () => {
    const h = await harness("tamper"), b = await h.port.inspect(), r = await request(b);
    await expect(h.port.runFresh(r, async () => {})).rejects.toThrow("physical_snapshot_mismatch");
  });
  it("rejects wrong compiled profile and pre-aborted work before any device command", async () => {
    const wrong = await harness("profile"); await expect(wrong.port.inspect()).rejects.toThrow("compiled_profile_mismatch");
    expect(wrong.calls).toHaveLength(0);
    const aborted = await harness(); await expect(aborted.port.inspect(AbortSignal.abort())).rejects.toThrow("cleanup_unconfirmed_deadline");
    expect(aborted.calls).toHaveLength(0);
  });
  it("locks on RSD failure without relaunch and never admits forged receipts", async () => {
    const h = await harness("rsd"); await expect(h.port.inspect()).rejects.toThrow("rsd_disconnected");
    await expect(h.port.inspect()).rejects.toThrow("port_busy_or_locked");
    expect(h.calls).toHaveLength(1);
  });
});
