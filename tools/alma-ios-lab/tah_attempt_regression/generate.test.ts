import { it, expect } from '../../../../ALMA/app/TAH/node_modules/vitest/dist/index.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadFixture, projectPhonePayload } from '../tah_phone_controller/controller.js';
import { buildRawGuardianAttemptV1, buildActorAttemptV1 } from '../../../../ALMA/app/TAH/src/framework/attempt-builders.js';
import { projectNativePromptChannelsV1 } from '../../../../ALMA/app/TAH/src/guest/adapter-kit/prompt-envelope.js';
import { renderUserInstructionLedgerV1 } from '../../../../ALMA/app/TAH/src/framework/user-instructions.js';
import { parseFrozenAttempt } from '../../../../ALMA/app/TAH/src/contract/index.js';

it('exports original Mac builder/projector fixtures without contacting any provider', async () => {
  const f = await loadFixture();
  const inference = {modelID: 'fixture-model-no-auth', reasoningEffortID: 'low'};
  const rawTranscript = f.rawTranscript + '\nSynthetic Unicode fixture: 中文 😀\n';
  const raw = buildRawGuardianAttemptV1({
    attemptID: '11111111-1111-4111-8111-111111111111', providerID: 'codex', inference,
    rawTranscript, guardianPrompt: f.resources.rawGuardianPrompt, safetyPolicy: f.resources.safetyPolicy,
  });
  const actor = buildActorAttemptV1({
    attemptID: '22222222-2222-4222-8222-222222222222', providerID: 'codex', inference,
    actorPromptTemplate: f.resources.actorPromptTemplate, revisionIndex: 0,
    actionInstructions: f.actionDefinition.renderActionInstructions('en', 'en'),
    outcomeContract: f.actionDefinition.outcomeContract, rawTranscript,
    extraInstructionsMarkdown: renderUserInstructionLedgerV1([{revisionIndex:0, initial:null, retries:[]}]),
    webEnabled:false, acceptedRevisions:[],
  });
  const directory = new URL('.cache/fixtures/', import.meta.url);
  await mkdir(directory, {recursive:true});
  const records = [];
  for (const [name,built] of [['raw',raw],['actor',actor]] as const) {
    parseFrozenAttempt(built.attempt);
    const payload = projectPhonePayload(built);
    const channels = projectNativePromptChannelsV1(built.attempt.prompt);
    expect(payload.attemptJSON).toBe(JSON.stringify(built.attempt));
    // Outer envelope spelling is the production Rust camelCase transport schema.
    // Do NOT normalize the original FrozenAttempt's ID/JSON/SHA field spelling.
    const envelope = {
      schema:'alma.phone-attempt/v1', runID:'33333333-3333-4333-8333-333333333333',
      challenge:'44444444-4444-4444-8444-444444444444',
      expectedAccountFingerprint:'a'.repeat(64), profileDigest:'b'.repeat(64),
      attemptJSON:payload.attemptJSON, attemptSHA256:payload.attemptSHA256,
      developerInstructions:channels.instructions, turnInputText:channels.referenceMessage,
      inputFiles:payload.inputFiles,
    };
    await writeFile(new URL(name+'.json',directory),JSON.stringify(envelope)+'\n');
    records.push({name,attemptID:built.attempt.attemptID,role:built.attempt.role,
      attemptSHA256:payload.attemptSHA256, materialFiles:payload.inputFiles.length,
      originalSchemaAccepted:true, identities:'Explicit fixture-only a*64 / b*64; not real auth/account/profile evidence'});
  }
  const paths = [
    '../../../../ALMA/app/TAH/src/framework/attempt-builders.ts',
    '../../../../ALMA/app/TAH/src/guest/adapter-kit/prompt-envelope.ts',
    '../../../../ALMA/app/TAH/src/contract/attempt.ts',
    '../tah_phone_controller/controller.ts',
  ];
  const sourceHashes = await Promise.all(paths.map(async path => ({
    path:new URL(path,import.meta.url).pathname,
    sha256:createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex'),
  })));
  await writeFile(new URL('.cache/fixtures/generation.json',import.meta.url),JSON.stringify({records,sourceHashes,
    scope:'Original TS builders, original channel projector and exact byte-map projector; no provider calls'},null,2)+'\n');
});
