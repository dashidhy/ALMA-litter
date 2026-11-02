import { describe, it, expect } from "../../../../ALMA/app/TAH/node_modules/vitest/dist/index.js";
import { createHash, randomUUID } from "node:crypto";
import { loadFixture, projectPhonePayload, bindingKey, assertSelection,
  unwiredPhonePort, unwiredJournal } from "./controller.js";
import { buildRawGuardianAttemptV1, buildActorAttemptV1 } from "../../../../ALMA/app/TAH/src/framework/attempt-builders.js";
import { renderUserInstructionLedgerV1 } from "../../../../ALMA/app/TAH/src/framework/user-instructions.js";
import { parseRawGuardianAssessmentV2 } from "../../../../ALMA/app/TAH/src/framework/guardian-assessment.js";
import { projectNativePromptChannelsV1 } from "../../../../ALMA/app/TAH/src/guest/adapter-kit/prompt-envelope.js";

describe("offline original TAH projections; no accepted phone attempts", () => {
  it("projects actual Raw builder bytes and trusted explanation context", async () => {
    const f = await loadFixture();
    const built = buildRawGuardianAttemptV1({ attemptID: randomUUID(), providerID: "codex",
      inference: f.guardianInference, rawTranscript: f.rawTranscript,
      guardianPrompt: f.resources.rawGuardianPrompt, safetyPolicy: f.resources.safetyPolicy });
    const wire = projectPhonePayload(built);
    expect(wire.attemptJSON).toBe(JSON.stringify(built.attempt));
    expect(wire.attemptSHA256).toBe(createHash("sha256").update(wire.attemptJSON).digest("hex"));
    expect(wire.inputFiles.map(x => x.relativePath)).toEqual(["raw-transcript.md"]);
    expect(Buffer.from(wire.inputFiles[0]!.base64, "base64").toString()).toBe(f.rawTranscript);
    const channels = projectNativePromptChannelsV1(built.attempt.prompt);
    expect(JSON.parse(channels.referenceMessage).blocks[0].authority).toBe("tah_trusted_context");
    const extraBytes = new Map(built.inputBytes).set("extra", new Uint8Array());
    expect(() => projectPhonePayload({ ...built, inputBytes: extraBytes })).toThrow("not exact");
  });
  it("preserves empty V0 semantics and rejects missing accepted V1 seed", async () => {
    const f = await loadFixture();
    const extra = renderUserInstructionLedgerV1([{ revisionIndex: 0, initial: null, retries: [] }]);
    expect(extra).toBe("# Extra Instructions\n\n## revision v0\n\nN/A\n");
    const input = { attemptID: randomUUID(), providerID: "codex", inference: f.guardianInference,
      actorPromptTemplate: f.resources.actorPromptTemplate, revisionIndex: 0,
      actionInstructions: f.actionDefinition.renderActionInstructions("en", "en"),
      outcomeContract: f.actionDefinition.outcomeContract, rawTranscript: f.rawTranscript,
      extraInstructionsMarkdown: extra, webEnabled: false, acceptedRevisions: [] };
    const built = buildActorAttemptV1(input);
    expect(built.attempt.workspace.candidateSeeds).toEqual([]);
    expect(built.attempt.workspace.writableRoots).toEqual(["outbox/revision_v0"]);
    expect(JSON.parse(projectNativePromptChannelsV1(built.attempt.prompt).referenceMessage).blocks).toEqual([]);
    expect(projectPhonePayload(built).inputFiles).toHaveLength(4);
    expect(() => buildActorAttemptV1({ ...input, revisionIndex: 1 })).toThrow();
  });
  it("uses the original closed Guardian parser; malformed receipt cannot allow", () => {
    expect(() => parseRawGuardianAssessmentV2('{"decision":"ALLOW","reasonCodes":[]}')).toThrow();
    expect(() => parseRawGuardianAssessmentV2('{"decision":"ALLOW","reasonCodes":[],"explanation":"Fixture.","accepted":true}')).toThrow();
  });
  it("binds dummy account/catalog data only in this pure test and rejects unavailable effort", () => {
    const binding = { providerID: "codex" as const, accountFingerprint: "a".repeat(64),
      profileDigest: "b".repeat(64), catalog: { models: [{ handle: "fixture-model", displayName: "Fixture",
        efforts: [{ handle: "low", displayName: "Low" }], defaultEffortHandle: "low" }], defaultModelHandle: "fixture-model" },
      authorization: { state: "valid", phase: "idle", inspecting: false, replacement: null,
        inspection: { id: "fixture-only", state: "succeeded" as const,
          startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", failures: [] } } };
    expect(bindingKey({ ...binding, accountFingerprint: "c".repeat(64) })).not.toBe(bindingKey(binding));
    assertSelection(binding, { modelID: "fixture-model", reasoningEffortID: "low" });
    expect(() => assertSelection(binding, { modelID: "fixture-model", reasoningEffortID: "high" })).toThrow();
    expect(() => bindingKey({ ...binding, authorization: { ...binding.authorization, inspection: null } })).toThrow();
  });
  it("unwired phone and durable journal fail closed", async () => {
    await expect(unwiredPhonePort.inspect()).rejects.toThrow("not wired");
    await expect(unwiredJournal.read("fixture")).rejects.toThrow("not wired");
  });
});
