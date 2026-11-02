// Runtime primitives only. No Provider or TAH business decisions live here.
globalThis.Buffer=__require('/vendor/buffer/index.js').Buffer;
const bufferFrom=Buffer.from,bufferToString=Buffer.prototype.toString,bufferByteLength=Buffer.byteLength,bufferFill=Buffer.prototype.fill;
// Optional public-JSCore/Foundation fastpaths. Larger or uncommon inputs keep
// the original Buffer implementation; the optimization does not narrow its API.
const nativeByteLimit=32*1024*1024;
const utf8Name=e=>e===undefined||e==='utf8'||e==='utf-8';
const normalizedEncoding=e=>typeof e==='string'?e.toLowerCase():e;
const isWellFormedString=String.prototype.isWellFormed;
const validUTF16=s=>isWellFormedString?isWellFormedString.call(s):!/[\uD800-\uDFFF]/u.test(s);
const nativeBytesAllowed=b=>b instanceof Uint8Array&&b.byteLength<=nativeByteLimit&&b.buffer instanceof ArrayBuffer&&b.buffer.resizable!==true;
const nativeBuffer=b=>{Object.setPrototypeOf(b,Buffer.prototype);return b;};
const nativeUTF8Text=(b,fatal)=>{
  try{return globalThis.__almaUTF8Decode(b,true);}
  catch(error){if(fatal||error.name!=='TypeError')throw error;return null;}
};
Buffer.prototype.fill=function(value,...rest){
  // Core integrity checks also wipe decoded outcome buffers, not only hash
  // temporaries. Preserve the wipe but avoid interpreting one store per byte.
  // All other values/ranges/overloads (including empty/detached views) retain
  // the original Buffer behavior.
  if(value===0&&rest.length===0&&this instanceof Uint8Array&&this.byteLength>0
      &&typeof globalThis.__almaSHA256Bytes==='function')return Uint8Array.prototype.fill.call(this,0);
  return bufferFill.call(this,value,...rest);
};
Buffer.from=function(value,encoding,...rest){
  const e=normalizedEncoding(encoding);
  if(typeof value==='string'&&rest.length===0){
    // Three UTF-8 bytes per UTF-16 code unit is a safe upper bound, including
    // replacement characters for unpaired surrogates. No oversized hook call.
    if(utf8Name(e)&&value.length<=Math.floor(nativeByteLimit/3)&&validUTF16(value)&&typeof globalThis.__almaUTF8Encode==='function')
      return nativeBuffer(globalThis.__almaUTF8Encode(value));
    // A conservative encoded-size bound avoids the native allocation cap.
    // Noncanonical and URL-safe strings retain the original permissive decoder.
    if(e==='base64'&&value.length<=Math.floor(nativeByteLimit/3)*4&&typeof globalThis.__almaBase64DecodeCanonical==='function'){
      const bytes=globalThis.__almaBase64DecodeCanonical(value);if(bytes!==null)return nativeBuffer(bytes);
    }
  }
  return bufferFrom.call(this,value,encoding==='base64url'?'base64':encoding,...rest);
};
Buffer.prototype.toString=function(encoding,...rest){
  const e=normalizedEncoding(encoding);
  if(nativeBytesAllowed(this)&&this.length>0&&rest.length===0){
    if(utf8Name(e)&&typeof globalThis.__almaUTF8Decode==='function'){
      const text=nativeUTF8Text(this,false);if(text!==null)return text;
    }
    if((e==='base64'||encoding==='base64url')&&typeof globalThis.__almaBase64Encode==='function'){
      const text=globalThis.__almaBase64Encode(this);
      return encoding==='base64url'?text.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''):text;
    }
  }
  const text=bufferToString.call(this,encoding==='base64url'?'base64':encoding,...rest);
  return encoding==='base64url'?text.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''):text;
};
Buffer.byteLength=function(value,encoding,...rest){
  const e=normalizedEncoding(encoding);
  // Buffer's third argument requires an explicit known encoding when true.
  if(typeof value==='string'&&value.length<=nativeByteLimit&&utf8Name(e)&&validUTF16(value)
      &&!(e===undefined&&rest[0]===true)&&typeof globalThis.__almaUTF8ByteLength==='function')
    return globalThis.__almaUTF8ByteLength(value);
  return bufferByteLength.call(this,value,encoding,...rest);
};
globalThis.TextEncoder=class {encode(value=''){
  const text=String(value);
  if(text.length<=Math.floor(nativeByteLimit/3)&&validUTF16(text)&&typeof globalThis.__almaUTF8Encode==='function')return globalThis.__almaUTF8Encode(text);
  return Uint8Array.from(Buffer.from(text,'utf8'));
}};
globalThis.TextDecoder=class {
  constructor(label='utf-8',options={}){if(!['utf-8','utf8'].includes(label.toLowerCase()))throw new Error('Unsupported encoding');this.fatal=!!options.fatal;}
  decode(value=new Uint8Array(),options={}){
    if(options.stream)throw new Error('Streaming decoder unsupported');
    const b=Buffer.from(value.buffer??value,value.byteOffset??0,value.byteLength);
    if(nativeBytesAllowed(b)&&typeof globalThis.__almaUTF8Decode==='function'){
      const text=nativeUTF8Text(b,this.fatal);if(text!==null)return text;
    }
    // Keep the existing polyfill's malformed-byte repair semantics as well as
    // its treatment of malformed UTF-16, instead of changing accepted content.
    const text=bufferToString.call(b,'utf8');if(this.fatal&&!Buffer.from(text,'utf8').equals(b))throw new TypeError('Invalid UTF-8');return text;
  }
};
globalThis.DOMException=class extends Error {constructor(message='',name='Error'){super(message);this.name=name;}};
globalThis.AbortSignal=class {
  constructor(){this.aborted=false;this.reason=undefined;this.listeners=new Map();}
  addEventListener(type,fn,options={}){if(type==='abort')this.listeners.set(fn,!!options.once);}
  removeEventListener(type,fn){if(type==='abort')this.listeners.delete(fn);}
  throwIfAborted(){if(this.aborted)throw this.reason;}
  _abort(reason){if(this.aborted)return;this.aborted=true;this.reason=reason;for(const [fn,once]of [...this.listeners]){if(once)this.listeners.delete(fn);fn({type:'abort',target:this});}this.onabort?.({type:'abort',target:this});}
  static abort(reason=new DOMException('Aborted','AbortError')){const s=new AbortSignal();s._abort(reason);return s;}
  static timeout(ms){const s=new AbortSignal();setTimeout(()=>s._abort(new DOMException('Timed out','TimeoutError')),ms);return s;}
  static any(signals){const c=new AbortController();for(const s of signals){if(s.aborted){c.abort(s.reason);break;}s.addEventListener('abort',()=>c.abort(s.reason),{once:true});}return c.signal;}
};
globalThis.AbortController=class {constructor(){this.signal=new AbortSignal();}abort(reason=new DOMException('Aborted','AbortError')){this.signal._abort(reason);}};
globalThis.structuredClone=function clone(v,seen=new Map()){
  if(v===null||typeof v!=='object')return v;if(seen.has(v))return seen.get(v);
  if(v instanceof Uint8Array)return new Uint8Array(v);if(v instanceof ArrayBuffer)return v.slice(0);if(v instanceof Date)return new Date(v);
  const out=Array.isArray(v)?[]:v instanceof Map?new Map():v instanceof Set?new Set():{};seen.set(v,out);
  if(v instanceof Map){for(const[k,x]of v)out.set(clone(k,seen),clone(x,seen));}
  else if(v instanceof Set){for(const x of v)out.add(clone(x,seen));}else for(const k of Object.keys(v))out[k]=clone(v[k],seen);return out;
};
