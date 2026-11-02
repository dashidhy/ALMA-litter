'use strict';
exports.randomUUID = () => globalThis.__almaUUID();
exports.createHash = algorithm => {
  if (algorithm !== 'sha256') throw new Error('Unsupported hash algorithm');
  let done=false, chunks=[];
  return { update(value,encoding) {
    if(done)throw new Error('Hash already finalized');
    chunks.push(Buffer.from(value,encoding));return this;
  },digest(encoding) {
    if(done)throw new Error('Hash already finalized');done=true;
    const input=Buffer.concat(chunks);chunks=[];
    // Hash the actual typed-array slice without a JS base64 round trip. Keep
    // the original route for larger inputs / hosts without the optional hook.
    let hex;
    try {
      hex=input.byteLength<=32*1024*1024&&typeof globalThis.__almaSHA256Bytes==='function'
        ?globalThis.__almaSHA256Bytes(input):globalThis.__almaSHA256(input.toString('base64'));
    } finally {
      // The browser Buffer polyfill fills byte-by-byte in JS. This is a known
      // Uint8Array and an all-zero wipe, so use the standard native bulk fill.
      if(typeof globalThis.__almaSHA256Bytes==='function')Uint8Array.prototype.fill.call(input,0);
      else input.fill(0);
    }
    const bytes=Buffer.from(hex,'hex');return encoding ? bytes.toString(encoding) : bytes;
  }};
};
