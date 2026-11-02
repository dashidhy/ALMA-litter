'use strict';
// Synthetic primitive tests only. This is not a CodeModeSession implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');

function context(extra = {}) {
  const ctx = vm.createContext(extra);
  vm.runInContext('delete globalThis.console; delete globalThis.Atomics; delete globalThis.SharedArrayBuffer; delete globalThis.WebAssembly;', ctx);
  return ctx;
}

async function moduleIn(source, ctx) {
  const rejectImport = specifier => { throw new Error('unsupported import: ' + specifier); };
  const mod = new vm.SourceTextModule(source, {
    context: ctx, identifier: 'exec_main.mjs', importModuleDynamically: rejectImport,
  });
  await mod.link(rejectImport);
  // CPU-loop cancellation is tested in an outer Worker, without this timeout.
  await mod.evaluate({timeout: 2000});
}

if (!isMainThread) {
  if (workerData.kind === 'cpu') {
    parentPort.once('message', message => {
      assert.equal(message, 'start-loop');
      fs.writeFileSync('/workspace/tmp/cpu-worker-phase.json', JSON.stringify({phase: 'loop-entering'}));
      parentPort.postMessage({type: 'loop-entering'});
      // Own finite-scope worker is externally terminated; host watchdog is armed.
      for (;;) {}
    });
    parentPort.postMessage({type: 'ready'});
  }
  if (workerData.kind === 'exit') {
    const send = value => parentPort.postMessage(value);
    const ctx = context({
      text: value => send({type: 'output', value}),
      store: (key, value) => send({type: 'store', key, value}),
      exit: () => { send({type: 'exit-requested'}); process.exit(0); },
      setTimeout, clearTimeout,
    });
    moduleIn(workerData.source, ctx).then(
      () => send({type: 'unexpected-evaluation-completed'}),
      error => { send({type: 'unexpected-evaluation-error', message: String(error)}); process.exitCode = 2; },
    );
  }
} else {
  const cases = [];
  function pass(name, details = {}) { cases.push({name, passed: true, ...details}); }

  async function modules() {
    const out = [];
    await moduleIn('let privateBinding = 7; globalThis.cellOnly = 9; text(await Promise.resolve(42));', context({text: v => out.push(v)}));
    assert.deepEqual(out, [42]);
    pass('SourceTextModule_top_level_await');
    const second = [];
    await moduleIn('text([typeof privateBinding, typeof cellOnly]);', context({text: v => second.push(JSON.parse(JSON.stringify(v)))}));
    assert.deepEqual(second, [['undefined', 'undefined']]);
    pass('fresh_module_and_context');
    await assert.rejects(moduleIn('import value from "./ordinary-unavailable-module.js";', context()), /unsupported import/);
    pass('static_import_rejected_by_link_hook');
    await assert.rejects(moduleIn('await import("./ordinary-unavailable-module.js");', context()), /unsupported import/);
    pass('dynamic_import_rejected_by_callback');
    const scratch = '/workspace/tmp/primitive.txt';
    fs.writeFileSync(scratch, 'private scratch\n');
    assert.equal(fs.readFileSync(scratch, 'utf8'), 'private scratch\n');
    fs.unlinkSync(scratch);
    pass('ordinary_private_scratch_roundtrip');
  }

  async function settled() {
    const helper = fs.readFileSync('/workspace/input/settled.js', 'utf8');
    const fixtures = JSON.parse(fs.readFileSync('/workspace/input/settled-fixtures.json', 'utf8'));
    for (const test of fixtures) {
      const output = [];
      const ctx = context({text: v => output.push(JSON.parse(JSON.stringify(v))), setTimeout, clearTimeout});
      vm.runInContext(helper, ctx, {timeout: 2000});
      await moduleIn(test.source, ctx);
      assert.deepEqual(output, [test.expected]);
      pass(test.name);
    }
  }

  function observeWorker(data) {
    const worker = new Worker(__filename, {workerData: data});
    const messages = [];
    let signalStart;
    const start = new Promise(resolve => { signalStart = resolve; });
    worker.on('message', message => { messages.push(message); signalStart(message); });
    const done = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => resolve({code, messages}));
    });
    return {worker, start, done, messages};
  }

  async function exitCases(group) {
    const sources = group === 'exit-sync' ? [
      ['catch_finally_queued_microtask', 'Promise.resolve().then(() => {text("microtask"); store("phase", "microtask");}); try {exit();} catch {text("caught");} finally {text("finally"); store("phase", "finally");} text("after");'],
      ['exit_stops_following_cpu_loop', 'exit(); for (;;) {}'],
    ] : [
      ['exit_after_top_level_await', 'await Promise.resolve(); try {exit();} catch {text("caught");} finally {text("finally");}'],
      ['exit_in_timer_while_awaiting', 'setTimeout(() => {try {exit();} catch {text("caught");} finally {text("finally");}}, 0); await new Promise(() => {});'],
    ];
    for (const [name, tail] of sources) {
      const execution = observeWorker({kind: 'exit', source: 'text("before"); store("phase", "before"); ' + tail});
      const {code, messages} = await execution.done;
      assert.equal(code, 0);
      // Compare after Worker exit, proving earlier messages were drained, not just sent.
      assert.deepEqual(messages, [
        {type: 'output', value: 'before'},
        {type: 'store', key: 'phase', value: 'before'},
        {type: 'exit-requested'},
      ]);
      pass(name, {worker_exit: code, messages_received_before_final_assertion: messages.length});
    }
  }

  async function cpu() {
    const phase = value => fs.writeFileSync('/workspace/tmp/cpu-phase.json', JSON.stringify({node: process.version, phase: value}));
    phase('worker-constructing');
    const execution = observeWorker({kind: 'cpu'});
    phase('worker-created');
    assert.deepEqual(await execution.start, {type: 'ready'});
    phase('worker-ready');
    const termination = new Promise((resolve, reject) => setTimeout(() => {
      phase('terminate-requested');
      execution.worker.terminate().then(resolve, reject);
    }, 100));
    execution.worker.postMessage('start-loop');
    phase('loop-start-sent');
    const terminated = await termination;
    phase('terminate-resolved');
    const {code, messages} = await execution.done;
    assert.equal(code, 1);
    assert.equal(terminated, code);
    assert.deepEqual(messages, [{type: 'ready'}, {type: 'loop-entering'}]);
    assert.deepEqual(JSON.parse(fs.readFileSync('/workspace/tmp/cpu-worker-phase.json', 'utf8')), {phase: 'loop-entering'});
    pass('external_Worker_terminate_cpu_loop', {worker_exit: code, termination_promise_resolved: true});
  }

  async function main() {
    const group = process.argv[2];
    if (group === 'modules') await modules();
    else if (group === 'settled') await settled();
    else if (group === 'exit-sync' || group === 'exit-async') await exitCases(group);
    else if (group === 'cpu') await cpu();
    else throw new Error('invalid group');
    process.stdout.write(JSON.stringify({node: process.version, flags: process.execArgv, group, cases, passed: true}) + '\n');
  }
  main().catch(error => {
    process.stdout.write(JSON.stringify({node: process.version, group: process.argv[2], cases, passed: false, error: String(error), stack: error.stack}) + '\n');
    process.exitCode = 1;
  });
}
