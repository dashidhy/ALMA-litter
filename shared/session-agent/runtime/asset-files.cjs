'use strict';

const fs = require('node:fs');
const { promisify } = require('node:util');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
// The callback realpath resolver supports the same ancestor traversal grants
// as the phone's existing SDK compatibility layer.
fs.promises.realpath = promisify(fs.realpath);
const io = fs.promises;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const contains = (root, target) => target === root || target.startsWith(root + path.sep);
const fail = code => Object.assign(new Error(code), { almaCode: code });
const knownErrno = new Set(['EACCES','EPERM','ENOSYS','ENOTSUP','EINVAL','EXDEV','EBADF','EIO','ENOENT','ENOSPC','ELOOP']);
async function ioStep(stage, operation) {
  try { return await operation(); }
  catch (error) { if (error.almaCode) throw error; throw fail(`${stage}_${knownErrno.has(error.code) ? error.code : 'io_error'}`); }
}
const tools = [
  { name: 'copy_file', description: 'Copy a complete workspace file into assets without regenerating its contents. Prefer this for creating a corrected transcript from transcript.md, then use Edit for targeted corrections. Can also copy an existing asset to another asset filename.',
    inputSchema: { type: 'object', properties: { source: {type:'string'}, destination: {type:'string'} }, required: ['source','destination'], additionalProperties:false },
    annotations: { readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false } },
  { name: 'delete_file', description: 'Delete one generated file inside assets. Original transcript, directories, shared skills and provider state cannot be deleted.',
    inputSchema: { type:'object', properties:{path:{type:'string'}},required:['path'],additionalProperties:false },
    annotations: { readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false } },
];

async function createAssetFiles(workspace, scratch) {
  const alias = path.resolve(workspace);
  const root = await io.realpath(alias);
  const tempRoot = await io.realpath(scratch);
  const assets = path.join(root, 'assets');
  if (contains(root, tempRoot) || contains(tempRoot, root)) throw fail('overlapping_roots');
  if (!(await io.lstat(root)).isDirectory() || !(await io.lstat(tempRoot)).isDirectory()) throw fail('invalid_roots');
  if (!(await io.lstat(assets)).isDirectory() || (await io.lstat(assets)).isSymbolicLink()) throw fail('invalid_assets');
  async function checked(value, writing, createParents = false) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)
      || value.split(/[\\/]/).some(p => p === '..') || value.includes('\\')) throw fail('invalid_path');
    let target = path.resolve(alias, value);
    if (contains(alias, target)) target = path.join(root, path.relative(alias, target));
    if (!contains(root,target) || target === root) throw fail('outside_workspace');
    if (writing && (!contains(assets,target) || target === assets)) throw fail('outside_assets');
    let current = root;
    const components = path.relative(root,target).split(path.sep);
    for (let index=0;index<components.length;index++) {
      current = path.join(current,components[index]);
      let info;
      try { info = await io.lstat(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (index === components.length-1) return {path:target,info:undefined};
        if (!createParents || !contains(assets,current) || current === assets) throw fail('parent_missing');
        await io.mkdir(current,{mode:0o700}); info=await io.lstat(current);
      }
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw fail('linked_path');
      if (index < components.length-1 && !info.isDirectory()) throw fail('parent_not_directory');
      if (index === components.length-1 && !info.isFile()) throw fail('not_a_file');
      if (index === components.length-1) return {path:target,info};
    }
    throw fail('invalid_path');
  }
  return {
    async call(name, args, signal = new AbortController().signal) {
      signal.throwIfAborted();
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid_arguments');
      if (name === 'delete_file') {
        if (Object.keys(args).some(key=>key!=='path')) throw fail('invalid_arguments');
        const target=await checked(args.path,true);
        if (target.info) {signal.throwIfAborted();await io.unlink(target.path);}
        return {path:path.relative(root,target.path),removed:Boolean(target.info)};
      }
      if (name !== 'copy_file' || Object.keys(args).some(key=>!['source','destination'].includes(key))) throw fail('unknown_tool');
      const source=await checked(args.source,false);
      if (!source.info) throw fail('source_missing');
      const destination=await checked(args.destination,true,true);
      if (source.path===destination.path) throw fail('same_file');
      if (source.info.size>MAX_COPY_BYTES) throw fail('copy_limit_32_mib');
      // iSH reports EXDEV for scratch-to-assets rename. Stage beside the target
      // so the final replacement stays within the same writable mount.
      const temporary=path.join(path.dirname(destination.path),`.alma-copy-${randomUUID()}`);
      let input, output, operationError;
      try {
        input=await ioStep('open_source',()=>io.open(source.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW));
        const initial=await ioStep('stat_source',()=>input.stat());
        if (!initial.isFile() || initial.nlink!==1 || initial.ino!==source.info.ino || initial.dev!==source.info.dev) throw fail('source_changed');
        const staged=temporary; output=await ioStep('open_temp',()=>io.open(staged,'wx',0o600));
        const buffer=Buffer.alloc(64*1024), digest=createHash('sha256'); let bytes=0;
        for (;;) {
          signal.throwIfAborted();
          const read=await ioStep('read_source',()=>input.read(buffer,0,buffer.length,null));
          if (!read.bytesRead) break;
          bytes+=read.bytesRead; if (bytes>MAX_COPY_BYTES) throw fail('copy_limit_32_mib');
          digest.update(buffer.subarray(0,read.bytesRead));
          for (let offset=0;offset<read.bytesRead;) {
            signal.throwIfAborted();
            const written=await ioStep('write_temp',()=>output.write(buffer,offset,read.bytesRead-offset,null));
            if (!written.bytesWritten) throw fail('copy_write_failed'); offset+=written.bytesWritten;
          }
        }
        const final=await input.stat();
        if (final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || bytes!==initial.size) throw fail('source_changed');
        await ioStep('sync_temp',()=>output.sync()); await ioStep('close_temp',()=>output.close()); output=undefined;
        await checked(args.destination,true);
        signal.throwIfAborted(); await ioStep('rename',()=>io.rename(staged,destination.path));
        return {path:path.relative(root,destination.path),bytes,sha256:digest.digest('hex')};
      } catch (error) { operationError=error; throw error; }
      finally {
        try {
          try { await input?.close(); }
          finally { try { await output?.close(); } finally { await ioStep('cleanup',()=>io.rm(temporary,{force:true})); } }
        } catch (error) { if (!operationError) throw error; }
      }
    },
  };
}

async function serve(workspace,scratch) {
  const files=await createAssetFiles(workspace,scratch);
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  const controllers=new Map(); let queue=Promise.resolve(), queued=0, closed=false;
  const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  function stop() {closed=true;for(const c of controllers.values())c.abort();lines.close();process.stdin.pause();}
  process.once('SIGTERM',stop); process.once('SIGINT',stop); process.stdout.on('error',stop);
  lines.on('line',line=>{
    if (closed) return;
    if (line.length>65536 || queued>=32) {stop();return;}
    let request; try {request=JSON.parse(line);} catch {send({id:null,error:{code:-32700,message:'invalid_json'}});return;}
    if (request.method==='notifications/cancelled') {controllers.get(request.params?.requestId)?.abort();return;}
    if (request.id===undefined || request.id===null) return;
    const controller=new AbortController();controllers.set(request.id,controller);queued++;
    queue=queue.then(async()=>{
      try {
        if (request.method==='initialize') send({id:request.id,result:{protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'alma-files',version:'1'}}});
        else if (request.method==='ping') send({id:request.id,result:{}});
        else if (request.method==='tools/list') send({id:request.id,result:{tools}});
        else if (request.method==='tools/call') {
          try {const result=await files.call(request.params?.name,request.params?.arguments,controller.signal);send({id:request.id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}});}
          catch(error){send({id:request.id,result:{content:[{type:'text',text:controller.signal.aborted?'cancelled':error.almaCode??(knownErrno.has(error.code)?`file_operation_${error.code}`:'file_operation_failed')}],isError:true}});}
        } else send({id:request.id,error:{code:-32601,message:'method_not_found'}});
      } finally {controllers.delete(request.id);queued--;}
    }).catch(()=>{stop();process.exitCode=1;});
  });
  lines.on('close',()=>{closed=true;for(const c of controllers.values())c.abort();});
}
if(require.main===module) serve(process.argv[2],process.argv[3]).catch(()=>{process.exitCode=1;});
module.exports={createAssetFiles,tools};
