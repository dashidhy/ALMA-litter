'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {createHash}=require('node:crypto');
const {createAssetFiles}=require('./asset-files.cjs');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(tmpdir(),'alma-files-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const workspace=path.join(base,'workspace'),scratch=path.join(base,'scratch');
 await fs.mkdir(path.join(workspace,'assets'),{recursive:true});await fs.mkdir(scratch);
 const source=await fs.readFile(path.join(__dirname,'../fixtures/nvidia-transcript.md'));
 await fs.writeFile(path.join(workspace,'transcript.md'),source);
 return {base,workspace,scratch,source,files:await createAssetFiles(workspace,scratch)};
}
test('copies the full real transcript byte for byte without changing its original',async t=>{
 const f=await fixture(t);const result=await f.files.call('copy_file',{source:'transcript.md',destination:'assets/nested/transcript.corrected.md'});
 assert.equal(result.bytes,143853);assert.equal(result.sha256,createHash('sha256').update(f.source).digest('hex'));
 assert.deepEqual(await fs.readFile(path.join(f.workspace,result.path)),f.source);
 assert.deepEqual(await fs.readFile(path.join(f.workspace,'transcript.md')),f.source);
 assert.deepEqual(await fs.readdir(f.scratch),[]);
 assert.equal((await f.files.call('delete_file',{path:result.path})).removed,true);
 assert.equal((await f.files.call('delete_file',{path:result.path})).removed,false);
});
test('denies source changes, private paths, traversal and linked files',async t=>{
 const f=await fixture(t), outside=path.join(f.base,'private.txt');await fs.writeFile(outside,'private');
 for(const [name,args] of [
  ['delete_file',{path:'transcript.md'}],['copy_file',{source:'transcript.md',destination:'transcript.md'}],
  ['copy_file',{source:outside,destination:'assets/leak'}],['copy_file',{source:'../private.txt',destination:'assets/leak'}],
 ]) await assert.rejects(f.files.call(name,args));
 await fs.symlink(outside,path.join(f.workspace,'assets/link'));
 await fs.link(outside,path.join(f.workspace,'assets/hard'));
 for(const source of ['assets/link','assets/hard']) await assert.rejects(f.files.call('copy_file',{source,destination:'assets/leak'}));
 await assert.rejects(f.files.call('copy_file',{source:'transcript.md',destination:'assets/link'}));
 assert.equal(await fs.readFile(outside,'utf8'),'private');
});
test('cancelled or oversized copies do not replace an existing asset',async t=>{
 const f=await fixture(t);const target=path.join(f.workspace,'assets/saved');await fs.writeFile(target,'keep');
 const abort=new AbortController();abort.abort();
 await assert.rejects(f.files.call('copy_file',{source:'transcript.md',destination:'assets/saved'},abort.signal));
 const huge=await fs.open(path.join(f.workspace,'assets/huge'),'w');await huge.truncate(33*1024*1024);await huge.close();
 await assert.rejects(f.files.call('copy_file',{source:'assets/huge',destination:'assets/saved'}),/copy_limit/);
 assert.equal(await fs.readFile(target,'utf8'),'keep');assert.deepEqual(await fs.readdir(f.scratch),[]);
});
test('stdio MCP exposes only the two scoped file operations',async t=>{
 const f=await fixture(t);const child=spawn(process.execPath,[path.join(__dirname,'asset-files.cjs'),f.workspace,f.scratch],{stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.kill();});const pending=new Map();let next=0;
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
 const call=(method,params)=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const init=await call('initialize',{protocolVersion:'2024-11-05'});assert.equal(init.result.serverInfo.name,'alma-files');
 const list=await call('tools/list',{});assert.deepEqual(list.result.tools.map(t=>t.name),['copy_file','delete_file']);
 const copied=await call('tools/call',{name:'copy_file',arguments:{source:'transcript.md',destination:'assets/copied.md'}});
 assert.equal(copied.result.isError,false);assert.equal(JSON.parse(copied.result.content[0].text).bytes,f.source.length);
 const denied=await call('tools/call',{name:'delete_file',arguments:{path:'transcript.md'}});assert.equal(denied.result.isError,true);
 child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
});
