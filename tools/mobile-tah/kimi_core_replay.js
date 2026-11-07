// Deterministic fixtures at the provider port. Real AppActions, AuthService,
// Framework guardians/critic/publisher, JSCore host, and SQLite journal execute.
// This is model-free host regression coverage, not SDK/native backend acceptance.
globalThis.AlmaMobileRuntime = {
  async invoke(method, input) {
    if (method !== 'proof') throw new Error('Unexpected replay entry');
    const attempts = [];
    const authCalls = [];
    const providers = {};
    const replacements = [];
    const privateMarker = 'PRIVATE_GUARDIAN_';
    const uid = () => __almaUUID();
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const publicOnly = value => check(!JSON.stringify(value).includes(privateMarker), 'Guardian content leaked into a public surface');
    let fixtureFailure = null;

    function fixtureProvider(profile, index) {
      const credential = Buffer.from(`00000000-0000-4000-8000-00000000000${index + 1}`);
      return {
        id: profile.id,
        async authenticate(context) {
          check(context.providerID === profile.id && !context.signal.aborted, 'Auth dispatch mismatch');
          authCalls.push({ providerID: profile.id, kind: context.kind });
          return {
            state: 'valid', credential: Uint8Array.from(credential), account: `${profile.id} synthetic replay`,
            catalog: {
              models: [{ handle: profile.guardianModel, displayName: `${profile.id} fixture model`,
                efforts: [{ handle: 'low', displayName: 'Low' }], defaultEffortHandle: 'low' }],
              defaultModelHandle: profile.guardianModel,
            },
            catalogUnavailable: false,
            accountUsage: { planLabel: 'Model-free replay', buckets: [{ id: 'fixture', label: 'Synthetic',
              remainingPercent: 100, quantity: null, period: null, unlimited: false, exhausted: false }],
              summaryBucketIDs: ['fixture'], exhausted: false },
            accountUsageUnavailable: false,
          };
        },
        async run(built, bytes, emit, signal) {
          try {
            check(!signal.aborted && Buffer.from(bytes).equals(credential), 'Wrong or cancelled credential dispatch');
            const attempt = built.attempt;
            check(attempt.providerID === profile.id, 'Attempt routed to the wrong provider');
            check(attempt.inference.modelID === profile.guardianModel, 'Unexpected model ID');
            check(attempt.inference.reasoningEffortID === 'low', 'Unexpected reasoning effort');
            const role = attempt.role;
            check(['raw_guardian', 'extra_guardian', 'actor'].includes(role), 'Unexpected fixture role');
            attempts.push({ providerID: profile.id, role, inference: attempt.inference,
              web: attempt.requiredAbilities.includes('web') });
            let sequence = 0;
            const event = async value => emit?.({ ...value, attemptID: attempt.attemptID, sequence: ++sequence });
            const commentary = role === 'actor' ? 'Synthetic progress — 原文核对。\n'.repeat(3000) : `${privateMarker}${role}`;
            await event({ kind: 'message_started', messageID: 'working', role: 'commentary' });
            // Keep individual normalized events inside their 64 KiB schema bound.
            for (let offset = 0; offset < commentary.length; offset += 8000) {
              await event({ kind: 'message_delta', messageID: 'working', text: commentary.slice(offset, offset + 8000) });
            }
            await event({ kind: 'message_completed', messageID: 'working' });
            if (role !== 'actor') {
              await event({ kind: 'tool_started', toolCallID: 'private-tool', operation: 'text_read', detail: `${privateMarker}tool` });
              await event({ kind: 'tool_completed', toolCallID: 'private-tool', status: 'completed', detail: `${privateMarker}result` });
              await event({ kind: 'plan_updated', markdown: `${privateMarker}plan` });
              await event({ kind: 'warning', text: `${privateMarker}warning` });
            }
            const finalText = role === 'actor' ? 'Recorded candidate replay.'
              : JSON.stringify({ decision: 'ALLOW', reasonCodes: [], explanation: 'Synthetic fixture allowed.' });
            await event({ kind: 'message_started', messageID: 'final', role: 'final_answer' });
            await event({ kind: 'message_delta', messageID: 'final', text: finalText });
            await event({ kind: 'message_completed', messageID: 'final' });
            const candidateFiles = new Map();
            const candidateManifest = [];
            if (role === 'actor') {
              const root = attempt.workspace.writableRoots[0];
              const match = root.match(/revision_v(\d+)$/);
              check(match !== null, 'Missing revision output root');
              const revision = Number(match[1]);
              check(revision >= 0 && revision < 3, 'Unexpected fixture revision');
              for (const name of Object.keys(input.revisions[revision]).sort()) {
                const relativePath = `${root}/${name}`;
                const data = Buffer.from(input.revisions[revision][name], 'base64');
                candidateFiles.set(relativePath, data);
                candidateManifest.push({ relativePath, kind: 'file', byteLength: data.length });
              }
              AlmaTAH.buildCandidateOutcomeV1(root, candidateManifest, candidateFiles);
            }
            return { terminal: { kind: 'end_turn', finalMessageID: 'final', finalText }, candidateManifest, candidateFiles };
          } catch (error) {
            fixtureFailure = String(error);
            throw error;
          }
        },
      };
    }

    const adapters = new Map(input.config.profiles.map((profile, index) => [profile.id, fixtureProvider(profile, index)]));
    let runtime = AlmaTAH.createMobileRuntime(adapters);
    const call = (name, value = {}) => runtime.invoke(name, value);
    async function until(read, predicate, label) {
      const deadline = Date.now() + 10000;
      for (let n = 0; n < 1000 && Date.now() < deadline; n++) {
        const value = await read();
        publicOnly(value);
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw new Error(`Bounded replay timed out waiting for ${label}`);
    }
    const authReady = () => until(() => call('auth.snapshot'), value => value.state === 'valid'
      && value.phase === 'idle' && !value.inspecting && value.inspection?.state === 'succeeded', 'authorization');
    async function history(actionID) {
      const items = [];
      let cursor = null;
      for (let page = 0; page < 16; page++) {
        const result = await call('action.conversation', { actionID, cursor });
        publicOnly(result);
        items.push(...result.items);
        if (result.nextCursor === null) return items;
        cursor = result.nextCursor;
      }
      throw new Error('Conversation exceeded replay page bound');
    }
    async function readLog(actionID, position, sha256) {
      let bytes = Buffer.alloc(0);
      let total;
      let parts = 0;
      do {
        check(parts < 86, 'Working log exceeded bounded chunk count');
        const chunk = await call('action.workingText', { actionID, position, sha256, offset: bytes.length });
        const part = Buffer.from(chunk.data, 'base64');
        check(part.length <= 48 * 1024 && chunk.totalBytes <= 4 * 1024 * 1024
          && (total === undefined || total === chunk.totalBytes) && part.length > 0, 'Invalid working log chunk');
        total = chunk.totalBytes;
        bytes = Buffer.concat([bytes, part]);
        parts++;
      } while (bytes.length < total);
      check(bytes.length === total && __almaSHA256(bytes.toString('base64')) === sha256, 'Working log hash drift');
      const log = JSON.parse(bytes.toString('utf8'));
      publicOnly(log);
      check(log.schemaVersion === 1 && parts >= 2 && log.events.some(event => event.role === 'actor'), 'Public multichunk log missing');
      check(log.events.every(event => event.role === 'actor' || (event.id === 'extra-safety-pass'
        && event.role === 'extra_guardian' && event.status === 'pass')), 'Private guardian events leaked');
      return { parts, bytes: total, sha256 };
    }
    async function verifyOutputs(actionID, revision) {
      const hashes = {};
      for (const path of ['structured-notes.md', 'suspicious-asr-terms.md']) {
        const result = await call('action.outcome', { actionID, revisionIndex: revision, path, offset: 0 });
        check(result.data === input.revisions[revision][path], 'Published fixture output changed');
        hashes[path] = __almaSHA256(result.data);
      }
      return hashes;
    }
    async function verifyHistory(proof) {
      const state = await call('action.snapshot', { actionID: proof.actionID });
      publicOnly(state);
      check(state.revisions.length === 3 && state.revisions.every(revision => revision.providerID === proof.providerID
        && revision.modelID === proof.modelID), 'Historical provider/model attribution changed');
      const rows = await history(proof.actionID);
      const finals = rows.filter(row => row.isFinalAnswer);
      check(finals.length === 3 && finals.every(row => row.providerID === proof.providerID && row.modelID === proof.modelID), 'Prior final history was lost');
      for (const log of proof.workingLogs) {
        await verifyOutputs(proof.actionID, log.revision);
        await readLog(proof.actionID, log.position, log.sha256);
      }
      return rows.length;
    }
    async function replaceProvider(target, cancelFirst = false) {
      const previous = await authReady();
      let replacement = await call('auth.replacement', { kind: 'switch_provider', providerID: target });
      check(replacement.providerID === previous.providerID && replacement.replacement?.providerID === target, 'Replacement committed before confirmation');
      if (cancelFirst) {
        const cancelledID = replacement.replacement.id;
        const cancelled = await call('auth.confirm', { id: cancelledID, confirmed: false });
        check(cancelled.providerID === previous.providerID && cancelled.state === 'valid'
          && cancelled.account === previous.account && cancelled.replacement === null, 'Cancellation replaced the account');
        replacement = await call('auth.replacement', { kind: 'switch_provider', providerID: target });
        let staleRejected = false;
        try { await call('auth.confirm', { id: cancelledID, confirmed: true }); } catch { staleRejected = true; }
        check(staleRejected, 'Stale replacement confirmation was accepted');
      }
      const selected = await call('auth.confirm', { id: replacement.replacement.id, confirmed: true });
      check(selected.providerID === target && selected.state === 'unauthed' && selected.actorCatalog === null,
        'Confirmed replacement retained the prior authorization/catalog');
      await call('auth.authorize');
      const authorized = await authReady();
      check(authorized.providerID === target, 'Wrong provider authorized after replacement');
      replacements.push({ from: previous.providerID, to: target, cancelledFirst: cancelFirst, confirmed: true });
    }
    async function replayProvider(profile, materialID) {
      const actionID = uid();
      await call('raw.check', { materialID, operationID: uid(), consent: true, interactionLanguage: 'en' });
      const raw = await until(() => call('raw.status', { materialID }), value => !value.busy, 'Raw Guardian');
      check(raw.state === 'allowed' && raw.providerID === profile.id, 'Provider-specific raw receipt missing');
      await call('action.create', { actionID, materialID, language: 'en' });
      const proof = { providerID: profile.id, modelID: profile.guardianModel, actionID, publications: [], workingLogs: [] };
      for (let revision = 0; revision < 3; revision++) {
        await authReady();
        await call('action.send', { actionID, operationID: uid(), instructions: input.deltas[revision],
          inference: { modelID: profile.guardianModel, reasoningEffortID: 'low' },
          interactionLanguage: revision === 2 ? 'zh-CN' : 'en', initialLanguage: 'en',
          grantWeb: revision === 1, consent: true, expectedProviderID: profile.id });
        const state = await until(() => call('action.snapshot', { actionID }), value => value.editorMode !== 'running'
          && !['running', 'preparing', 'actor', 'critic', 'extra_guardian', 'saving_safety', 'saving'].includes(value.phase), 'publication');
        check(state.revisions.length === revision + 1, `Publication failed ${profile.id} V${revision}: ${fixtureFailure ?? state.error ?? state.phase}`);
        check(state.language === 'en' && state.initialSettingsFrozen, 'Initial output language changed');
        const row = (await history(actionID)).find(item => item.revisionIndex === revision && item.isFinalAnswer);
        check(row?.criticRounds?.length === 1 && row.criticRounds[0].decision === 'PASS', 'Real Framework critic did not PASS');
        const stages = row.presentation?.stages.map(stage => stage.phase) ?? [];
        check(stages.includes('actor') && stages.includes('critic'), 'Actor/critic stage receipts missing');
        if (revision > 0) check(stages.includes('extra_guardian'), 'Extra Guardian stage missing');
        const outputSHA256 = await verifyOutputs(actionID, revision);
        check(row.presentation?.workingLogSHA256, 'Publication log descriptor missing');
        const log = await readLog(actionID, row.position, row.presentation.workingLogSHA256);
        let wrongHashRejected = false;
        try { await call('action.workingText', { actionID, position: row.position, sha256: '0'.repeat(64), offset: 0 }); }
        catch (error) { wrongHashRejected = error.code === 'busy'; }
        check(wrongHashRejected, 'Wrong log hash accepted');
        proof.publications.push({ revision, phase: state.phase, criticDecision: row.criticRounds[0].decision, outputSHA256, stages });
        proof.workingLogs.push({ revision, position: row.position, ...log, wrongHashRejected });
      }
      providers[profile.id] = proof;
      return proof;
    }

    try {
      await call('runtime.initialize', input.config);
      await call('auth.select', { providerID: 'codex' });
      await call('auth.authorize');
      await authReady();
      const transcriptID = uid();
      const materialID = uid();
      await call('material.put', { transcriptID, materialID, title: 'Model-free parity fixture', rawTranscript: input.transcript });
      await replayProvider(input.config.profiles.find(profile => profile.id === 'codex'), materialID);
      await replaceProvider('kimi', true);
      await verifyHistory(providers.codex);
      const before = await call('raw.status', { materialID });
      check(before.providerID === 'kimi' && before.state !== 'allowed', 'Codex raw receipt authorized Kimi');
      await replayProvider(input.config.profiles.find(profile => profile.id === 'kimi'), materialID);
      await replaceProvider('codex');
      for (const proof of Object.values(providers)) proof.historyItemsAfterReplacement = await verifyHistory(proof);
      for (let revision = 0; revision < 3; revision++) {
        check(JSON.stringify(providers.codex.publications[revision].outputSHA256)
          === JSON.stringify(providers.kimi.publications[revision].outputSHA256), 'Cross-provider publication drift');
      }
      await call('runtime.shutdown');
      runtime = AlmaTAH.createMobileRuntime(adapters);
      await call('runtime.initialize', input.config);
      await authReady();
      for (const proof of Object.values(providers)) proof.historyItemsAfterRuntimeRestart = await verifyHistory(proof);
      return { passed: true, modelCalls: false, hostOnly: true, nativeBackendQualified: false,
        scope: 'Real AppActions/AuthService/Framework deterministic critic/publisher in Swift JSCore and SQLite with synthetic provider-port replies',
        exclusions: ['No LLM inference', 'No Kimi SDK execution', 'No native provider backend', 'No native Keychain or handle revocation qualification', 'No phone launch'],
        attempts, authCalls, providers, replacements, historyReadableAfterReplacement: true,
        historyReadableAfterRuntimeRestart: true, privateGuardianLogsExcluded: true, crossProviderPublicationParity: true };
    } finally {
      await call('runtime.shutdown');
    }
  },
};
