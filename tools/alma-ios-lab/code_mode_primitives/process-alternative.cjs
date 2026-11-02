'use strict';
// Separate per-cell process primitive; does not assert Worker cancellation works.
const fs = require('node:fs');
const vm = require('node:vm');
const write = value => fs.writeSync(1, JSON.stringify(value) + '\n');
if (process.argv[2] === 'process-cpu') {
  write({node: process.version, flags: process.execArgv, phase: 'loop-entering'});
  for (;;) {} // Trusted PID1 cancels precisely this owned job.
} else if (process.argv[2] === 'process-exit') {
  const output = [];
  const writes = {};
  const ctx = vm.createContext({
    text: value => output.push(value),
    store: (key, value) => { writes[key] = value; },
    exit: () => {
      // Synthetic complete write-set frame, synchronously drained into a pipe.
      // A real provider would commit it only after verified normal completion.
      write({node: process.version, flags: process.execArgv, output, writes, phase: 'exit-requested'});
      process.exit(0);
    },
  });
  const source = `text('before'); store('phase', 'before'); await Promise.resolve();
    Promise.resolve().then(() => {text('microtask'); store('phase', 'microtask');});
    try {exit();} catch {text('caught');} finally {text('finally'); store('phase', 'finally');}
    text('after');`;
  const mod = new vm.SourceTextModule(source, {context: ctx});
  mod.link(() => { throw new Error('unsupported import'); })
    .then(() => mod.evaluate())
    .then(() => { write({unexpected: 'evaluation returned'}); process.exitCode = 2; })
    .catch(error => { write({unexpected: String(error)}); process.exitCode = 2; });
} else {
  throw new Error('invalid process alternative');
}
