import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../../shared/tah-runtime/generated');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'bundle-manifest.json'),'utf8'));
const source=fs.readFileSync(path.join(root,'alma-tah.js'),'utf8');
assert(!manifest.coreModules.some(id=>id.startsWith('/zcode/')||id.startsWith('/platform/codex/')||id.startsWith('/platform/kimi/')));
const results=[];
for(const selected of ['codex','kimi','zcode']){
  const loaded=[],evaluated=[];
  const context=vm.createContext({console,__almaUUID:randomUUID,__almaSHA256:base64=>createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex'),__almaURL:(relative,base)=>new URL(relative,base).href});
  context.__almaLoadProviderChunk=name=>{
    loaded.push(name);
    const chunk=manifest.chunks[name],text=fs.readFileSync(path.join(root,chunk.filename),'utf8');
    assert.equal(Buffer.byteLength(text),chunk.bytes);
    assert.equal(createHash('sha256').update(text).digest('hex'),chunk.sha256);
    vm.runInContext(text,context);return true;
  };
  vm.runInContext(source,context);
  assert.deepEqual(loaded,[]);
  assert.throws(() => context.AlmaLoadProvider('invalid'), /Unknown provider/);
  assert.deepEqual(loaded,[]);
  const install=context.AlmaInstallProviderChunk;
  context.AlmaInstallProviderChunk=(name,definitions,links)=>{
    for(const [id,factory]of Object.entries(definitions))definitions[id]=(...args)=>{evaluated.push(id);return factory(...args);};
    return install(name,definitions,links);
  };
  const first=context.AlmaLoadProvider(selected);
  assert.equal(first.id,selected);assert.equal(context.AlmaLoadProvider(selected),first);
  assert.deepEqual(loaded,[selected]);
  for(const other of ['codex','kimi','zcode'].filter(id=>id!==selected)){
    assert(!evaluated.some(id=>manifest.chunks[other].modules.includes(id)));
  }
  for(const next of ['zcode','kimi','codex'])assert.equal(context.AlmaLoadProvider(next).id,next);
  assert.equal(new Set(loaded).size,3);assert.equal(loaded.length,3);
  results.push({selected,loaded,evaluated:evaluated.length,unusedProviderEvaluation:false});
}
console.log(JSON.stringify({passed:true,scenarios:results}));
