'use strict';

// stdout is a nonblocking pipe once Node/SDK stream APIs initialize it.
// Writable handles partial writes and EAGAIN; sync writes can leave half a frame.
function createProtocolWriter(prefix, options = {}) {
  const stream = options.stream ?? process.stdout;
  const write = stream.write.bind(stream);
  const frameLimit = options.frameLimit ?? (() => 2 * 1024 * 1024);
  const queueLimit = options.queueLimit ?? 32 * 1024 * 1024;
  const diagnostic = options.diagnostic ?? (() => {});
  let tail = Promise.resolve(), queuedBytes = 0, failure;
  stream.on('error', error => { failure = error; });
  if (options.redirectStdout !== false && stream === process.stdout) {
    const stderrWrite = process.stderr.write.bind(process.stderr);
    stream.write = function (...args) {
      diagnostic({event:'redirected_stdout',bytes:Buffer.byteLength(args[0])});
      const accepted = stderrWrite(...args);
      if (!accepted) process.stderr.once('drain', () => stream.emit('drain'));
      return accepted;
    };
  }
  return {
    send(frame) {
      if (failure) throw failure;
      const bytes = Buffer.from(prefix + JSON.stringify(frame) + '\n');
      if (bytes.length > frameLimit() || queuedBytes + bytes.length > queueLimit) throw new Error('protocol_output_limit');
      diagnostic({event:'protocol_send',kind:frame.kind,bytes:bytes.length});
      queuedBytes += bytes.length;
      const pending = tail.then(() => new Promise((resolve,reject) => {
        write(bytes, error => error ? reject(error) : resolve());
      })).then(
        () => { queuedBytes -= bytes.length; },
        error => { queuedBytes -= bytes.length; failure=error; throw error; },
      );
      pending.catch(() => {});
      tail = pending;
      return pending;
    },
    flush() { return tail; },
  };
}
module.exports = {createProtocolWriter};
