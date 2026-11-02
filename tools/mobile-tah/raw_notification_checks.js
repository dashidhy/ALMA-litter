// Run after the unchanged core_replay.js, inside the unchanged core_replay.swift.
// All Framework, AppActions, Auth, notification queues and journal code come from
// the real bundle. Only the existing synthetic provider and transport are gated.
const rawReplayFixture = globalThis.AlmaMobileRuntime;

globalThis.AlmaMobileRuntime = {async invoke(method, input) {
  if (method !== 'proof') throw new Error('Unexpected test entry');
  const native = globalThis.__almaPlatformCall;
  const exports = globalThis.AlmaTAH;
  const checks = [], cases = [];
  let current = 'capture synthetic provider';
  const expect = (condition, name) => {
    if (!condition) throw new Error(`${current}: ${name}`);
    checks.push(`${current}: ${name}`);
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return {promise, resolve};
  };
  const events = () => {
    const values = [], waiting = [];
    return {values, emit(value) {
      values.push(value);
      for (const waiter of [...waiting]) if (waiter.test(value)) {
        waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(value);
      }
    }, wait(test) {
      const found = values.find(test);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise(resolve => waiting.push({test, resolve}));
    }};
  };

  async function captureProvider() {
    // Stop replay at its composition boundary, before it initializes any core.
    // This reuses its actual provider closure, without copying that implementation
    // or changing any bundled module. Restore the real export before testing.
    const captured = new Error('Synthetic provider captured');
    let adapters;
    globalThis.AlmaTAH = {...exports, createMobileRuntime(value) {
      adapters = value;
      return {async invoke() { throw captured; }};
    }};
    try {
      await rawReplayFixture.invoke('proof', input);
      throw new Error('Replay fixture did not reach its composition boundary');
    } catch (error) { if (error !== captured) throw error; }
    finally { globalThis.AlmaTAH = exports; }
    expect(adapters?.get('codex')?.run instanceof Function, 'unchanged replay provider captured');
    return adapters.get('codex');
  }

  function controlledProvider(base, outcome, gate = null) {
    const entered = deferred();
    let calls = 0;
    return {entered, get calls() { return calls; }, adapter: {...base,
      async run(built, bytes, emit, signal) {
        if (built.attempt.role !== 'raw_guardian') throw new Error('Unexpected non-Raw inference');
        calls++; entered.resolve();
        if (outcome === 'cancel') {
          await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, {once: true});
          });
          throw new Error('Synthetic provider cancelled');
        }
        if (gate) await gate.promise;
        if (outcome === 'fail') throw new Error('Synthetic provider unavailable');
        // Change only provider output, keeping the real Guardian parser/validator.
        const text = JSON.stringify({decision: 'BLOCK', reasonCodes: ['harmful_content'],
          explanation: 'Synthetic blocked fixture.'});
        const result = await base.run(built, bytes, event => emit?.(
          outcome === 'block' && event.kind === 'message_delta' && event.messageID === 'replay-final'
            ? {...event, text} : event), signal);
        return outcome === 'block' ? {...result, terminal: {...result.terminal, finalText: text}} : result;
      }
    }};
  }

  async function run() {
    const base = await captureProvider();
    const authEvents = events(), rawEvents = events();
    let rawACK = null, nativeProviderCalls = 0;
    globalThis.__almaPlatformCall = async (method, value) => {
      if (method.startsWith('provider.')) {
        nativeProviderCalls++;
        throw new Error('Native provider forbidden in synthetic checks');
      }
      if (method === 'ui.auth') authEvents.emit(value);
      if (method === 'ui.rawChanged') {
        rawEvents.emit(value);
        const gate = rawACK; rawACK = null;
        if (gate) await gate.promise;
      }
      // SQLite and in-memory synthetic credential storage use the original host.
      return native(method, value);
    };

    // material.put uses the original composition's real ServiceJournal writer.
    const materialRuntime = exports.createMobileRuntime(new Map([['codex', base]]));
    async function material(label) {
      const materialID = __almaUUID(), transcriptID = __almaUUID();
      await materialRuntime.invoke('material.put', {materialID, transcriptID,
        title: label, rawTranscript: `${input.transcript}\nSynthetic case: ${label}`});
      return materialID;
    }
    async function authFor(provider) {
      const empty = providerID => ({version: 1, providerID, state: 'unauthed', credential: null,
        account: null, checkedAt: null});
      let record = empty(null);
      const auth = new exports.AuthService({
        load: async () => record, save: async value => { record = value; },
        reset: async providerID => { record = empty(providerID); }, close: async () => {}
      }, context => provider.authenticate(context));
      await auth.initialize();
      const ready = deferred();
      const unobserve = auth.observe(s => { if (s.inspection?.state === 'succeeded') ready.resolve(); });
      await auth.select('codex'); await auth.authorize(); await ready.promise; unobserve();
      return auth;
    }

    async function directCase(outcome, options = {}) {
      current = `${outcome}${options.throws ? '/throwing-observer' : ''}${options.delayCommit ? '/delayed-commit-ACK' : ''}${options.pending ? '/pending-save' : ''}`;
      const label = current, materialID = await material(label), operationID = __almaUUID();
      const providerGate = deferred(), provider = controlledProvider(base, outcome, providerGate);
      const auth = await authFor(provider.adapter);
      const scheduler = new exports.BoundedTahHostOperationSchedulerV1();
      const notices = events(), headers = new Map();
      const commitEntered = deferred(), commitACK = deferred();
      let writes = 0, injected = false, committed = false, acknowledged = false, core;
      const bridge = {close() { throw new Error('Unexpected bridge closure'); }, async call(method, value) {
        if (method === 'store.begin') { writes++; headers.set(value.operationID, value); }
        const header = headers.get(value.operationID);
        if (options.pending && !injected && method === 'store.commit' && header?.streamID.startsWith('raw-check/')) {
          injected = true;
          throw new Error('Synthetic commit failure before durable commit');
        }
        const result = await globalThis.__almaPlatformCall(method, value);
        if (options.delayCommit && method === 'store.commit' && header?.streamID.startsWith('raw-check/') && header.expectedVersion === 1) {
          committed = true; commitEntered.resolve();
          await commitACK.promise; acknowledged = true;
        }
        return result;
      }};
      // Thin synthetic adapter delegation only. Core still constructs and runs
      // its real Workflow, Liveness, persistence, raw parser and cancellation.
      const port = {run: (built, emit, signal) => auth.withCredential('codex',
        (bytes, authorizationSignal) => provider.adapter.run(built, bytes, emit, authorizationSignal), signal)};
      core = new exports.AppActions(bridge, auth, input.config.profiles, scheduler,
        input.config.resources, input.config.actionInstructions, port, () => {
          notices.emit({busy: core.busy, writes, acknowledged});
          if (options.throws) throw new Error('Synthetic observer failure');
        });
      try {
        const terminal = notices.wait(n => !n.busy);
        await core.checkRawSafety({materialID, operationID, consent: true, interactionLanguage: 'en'});
        expect(notices.values[0]?.busy === true && notices.values[0].writes === 0,
          'start notification follows active assignment and precedes first write');
        if (options.pending) {
          await notices.wait(n => n.writes > 0);
          const pending = await core.rawSafetyStatus(materialID);
          expect(injected && pending.busy && typeof pending.pendingSave === 'string',
            'onPending notification exposes real pending save without polling');
          expect(provider.calls === 0, 'failed initial save has not reached provider');
          await core.retrySave(pending.pendingSave);
        }
        await provider.entered.promise;
        if (options.pending) {
          const resumed = await core.rawSafetyStatus(materialID);
          expect(resumed.busy && resumed.pendingSave === null &&
            notices.values.some(n => n.busy && n.writes === 2),
          'successful retry notifies pending-save clearance before provider completion');
        }
        if (outcome === 'cancel') await core.cancelRawSafety(operationID);
        else providerGate.resolve();
        if (options.delayCommit) {
          await commitEntered.promise;
          const beforeACK = await core.rawSafetyStatus(materialID);
          expect(committed && !acknowledged && core.busy && beforeACK.state === 'checking',
            'durable terminal commit before JS ACK is still checking');
          expect(notices.values.every(n => n.busy), 'no terminal notification before final ACK');
          commitACK.resolve();
        }
        const finalNotice = await terminal;
        const final = await core.rawSafetyStatus(materialID);
        const expected = {allow: 'allowed', block: 'blocked', fail: 'failed', cancel: 'cancelled'}[outcome];
        expect(final.state === expected && !final.busy && final.activeCheckID === null,
          'finally notification observes cleared active and authoritative terminal state');
        expect(notices.values.filter(n => !n.busy).length === 1, 'one final active-cleared observation');
        expect(final.pendingSave === null && provider.calls === 1, 'no pending save or duplicate provider run');
        if (options.delayCommit) expect(finalNotice.acknowledged, 'terminal notification follows ACK continuation');
        const count = notices.values.length;
        expect(count === (options.pending ? 4 : 2),
          'only start/finally and actual pending-save changes notify; repeated null saves stay silent');
        if (outcome === 'allow' || outcome === 'block') {
          await core.checkRawSafety({materialID, operationID, consent: true, interactionLanguage: 'en'});
          expect(notices.values.length === count && provider.calls === 1, 'cached replay does not invent lifecycle notifications');
        }
        cases.push({name: label, state: final.state, observations: count, providerCalls: provider.calls});
      } finally {
        providerGate.resolve(); commitACK.resolve();
        await core.close(); await auth.close(); await scheduler.close();
      }
    }

    for (const outcome of ['allow', 'block', 'fail', 'cancel']) {
      await directCase(outcome);
      await directCase(outcome, {throws: true});
    }
    await directCase('allow', {delayCommit: true});
    await directCase('block', {delayCommit: true});
    await directCase('allow', {pending: true, throws: true});

    // Exercise the actual composition's private LatestAppNotifications queue.
    // A real raw.cancel joins the task/finally while the initial UI ACK is held;
    // this gives an explicit completion barrier, without a timer or status poll.
    current = 'mobile-runtime/delayed-ui-ACK';
    const mobileProvider = controlledProvider(base, 'cancel');
    const runtime = exports.createMobileRuntime(new Map([['codex', mobileProvider.adapter]]));
    let gate;
    try {
      await runtime.invoke('runtime.initialize', input.config);
      await runtime.invoke('auth.select', {providerID: 'codex'});
      const authReady = authEvents.wait(s => s.inspection?.state === 'succeeded');
      await runtime.invoke('auth.authorize', {}); await authReady;
      // Auth reads advance only the Auth revision, never Raw's revision.
      for (let n = 0; n < 5; n++) await runtime.invoke('auth.snapshot', {});
      const materialID = await material(current), operationID = __almaUUID();
      gate = deferred(); rawACK = gate;
      await runtime.invoke('raw.check', {materialID, operationID, consent: true, interactionLanguage: 'en'});
      await mobileProvider.entered.promise;
      expect(rawEvents.values.length === 1 && rawEvents.values[0].sourceRevision === 1,
        'one in-flight UI delivery; Raw revision independent from Auth');
      await runtime.invoke('raw.cancel', {operationID});
      const settled = await runtime.invoke('raw.status', {materialID});
      expect(!settled.busy && settled.state === 'cancelled', 'Core finishes while first UI ACK remains blocked');
      // Successful saves no longer emit redundant onPending(null) notifications.
      // Complete another lifecycle under the same held ACK to test real queue
      // replacement: revisions 2, 3 and 4 must coalesce into revision 4.
      const burstMaterial = await material('second lifecycle under held UI ACK'), burstOperation = __almaUUID();
      await runtime.invoke('raw.check', {materialID: burstMaterial, operationID: burstOperation,
        consent: true, interactionLanguage: 'en'});
      await runtime.invoke('raw.cancel', {operationID: burstOperation});
      expect(rawEvents.values.length === 1, 'two lifecycle completions coalesce behind in-flight ACK');
      const newest = rawEvents.wait(n => n.sourceRevision > 1);
      gate.resolve();
      const finalEvent = await newest;
      const final = await runtime.invoke('raw.status', {materialID: burstMaterial});
      expect(finalEvent.sourceID === rawEvents.values[0].sourceID && finalEvent.sourceRevision === 4,
        'two start/finally pairs yield exactly four revisions; queue retains the last');
      expect(rawEvents.values.length === 2 && !final.busy && final.state === 'cancelled',
        'exactly one follow-up notification reads final state without polling');
      expect(Object.keys(finalEvent).sort().join(',') === 'sourceID,sourceRevision',
        'Raw event remains a small invalidation, not a guessed permission/state');
      cases.push({name: current, state: final.state, deliveries: rawEvents.values.length,
        revisions: rawEvents.values.map(n => n.sourceRevision)});

      // The next start is a revision fence: no Raw changes happen between a
      // joined final task and the next start. This detects delivery of an older
      // queued value even when a later raw.status happens to read final state.
      const nextMaterial = await material('next revision fence'), nextOperation = __almaUUID();
      gate = deferred(); rawACK = gate;
      const nextEvent = rawEvents.wait(n => n.sourceRevision > finalEvent.sourceRevision);
      await runtime.invoke('raw.check', {materialID: nextMaterial, operationID: nextOperation,
        consent: true, interactionLanguage: 'en'});
      const nextStart = await nextEvent;
      expect(nextStart.sourceRevision === finalEvent.sourceRevision + 1,
        'delayed delivery was the exact last revision, verified by next-start fence');
      await runtime.invoke('raw.cancel', {operationID: nextOperation});
      const nextFinal = rawEvents.wait(n => n.sourceRevision > nextStart.sourceRevision);
      gate.resolve(); await nextFinal;
    } finally { gate?.resolve(); await runtime.invoke('runtime.shutdown', {}); }
    expect(nativeProviderCalls === 0, 'no native provider or model access');
    return {passed: true, modelCalls: false, realCredentials: false, hostOnly: true,
      checks: checks.length, cases, assertions: checks};
  }

  // Watchdog only fails a hung test; it never releases a gate or declares success.
  let watchdog;
  try {
    return await Promise.race([run(), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`Raw notification check stalled: ${current}`)), 20000);
    })]);
  } finally {
    clearTimeout(watchdog);
    globalThis.__almaPlatformCall = native;
    globalThis.AlmaTAH = exports;
  }
}};
