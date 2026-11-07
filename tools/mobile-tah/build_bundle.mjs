import ts from 'typescript';
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {adaptRuntimeNotifications,runtimeNotificationChanges} from './runtime_notifications.mjs';
const providerSources=JSON.parse(execFileSync('python3',[
  fileURLToPath(new URL('./provider_sources.py',import.meta.url)),'--sources'],{encoding:'utf8'}));
const root=providerSources.tahRuntime;
const out=path.join(root,'generated');fs.mkdirSync(out,{recursive:true});
const sources=new Map(),maps=new Map();
const sourceRecords=new Map();
const upstreamLock=JSON.parse(fs.readFileSync(path.join(root,'source-lock.json'),'utf8')).files;
const vendorLock=JSON.parse(fs.readFileSync(path.join(root,'vendor-lock.json'),'utf8'));
const providerLocks=Object.fromEntries(Object.entries(providerSources.providers).map(([name,provider])=>
  [name,new Map(provider.files.map(file=>['/'+file.path,file.sha256]))]));
function owner(id){
  if(id.startsWith('/platform/codex/')||id.startsWith('/upstream/providers/codex/'))return 'codex';
  if(id.startsWith('/platform/kimi/'))return 'kimi';
  if(id.startsWith('/zcode/'))return 'zcode';
  return 'app';
}
function sourcePath(id){
  if(!id.startsWith('/')||path.posix.normalize(id)!==id||id.includes('\\'))throw new Error('Invalid source ID '+id);
  const provider=owner(id);
  return path.join(provider==='app'?root:providerSources.providers[provider].adapter,provider==='zcode'?id.slice('/zcode/'.length):id);
}
function readSource(id){
  const source=sourcePath(id),bytes=fs.readFileSync(source);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const provider=owner(id);
  let expected;
  if(provider!=='app')expected=providerLocks[provider].get(provider==='zcode'?id.slice('/zcode'.length):id);
  else if(id.startsWith('/upstream/'))expected=upstreamLock[id.slice('/upstream/'.length)];
  else if(id.startsWith('/vendor/')){
    const [,,name,...relative]=id.split('/');expected=vendorLock[name]?.files[relative.join('/')];
  }else expected=sha256;
  if(expected!==sha256)throw new Error('Source lock mismatch '+source);
  sourceRecords.set(id,{id,owner:provider,source,bytes:bytes.length,sourceSHA256:sha256});
  return bytes.toString('utf8');
}
const builtins={'node:crypto':'platform/node-crypto.js','node:path':'platform/node-path.js','node:fs/promises':'platform/node-fs-promises.js','node:fs':'platform/unavailable-node-fs.js','node:child_process':'platform/unavailable-node-process.js'};
const packages={zod:'vendor/zod/index.cjs',buffer:'vendor/buffer/index.js','base64-js':'vendor/base64-js/index.js',ieee754:'vendor/ieee754/index.js'};
function resolve(from,spec){
  if(spec.startsWith('@alma/zcode/'))return resolve('/zcode/entry.ts','./'+spec.slice('@alma/zcode/'.length));
  if(spec.startsWith('@alma/tah/'))return resolve('/upstream/src/entry.ts','./'+spec.slice('@alma/tah/'.length));
  if(spec==='@alma/platform/provider.js')return '/platform/provider.ts';
  if(spec==='@alma/vendor/zod')return '/vendor/zod/index.cjs';
  if(builtins[spec])return '/'+builtins[spec];if(packages[spec])return '/'+packages[spec];
  if(!spec.startsWith('.'))throw new Error('Unmapped runtime dependency: '+spec+' from '+from);
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
  const options=[target,target.replace(/\.js$/,'.ts'),target+'/index.ts',target+'/index.cjs'];
  const found=options.find(p=>fs.existsSync(sourcePath(p))&&fs.statSync(sourcePath(p)).isFile());
  if(!found||!['/platform/','/upstream/','/vendor/','/zcode/'].some(p=>found.startsWith(p)))throw new Error('Unresolved closed module '+target);
  if(found==='/upstream/providers/codex/adapter/src/receipts.ts')return '/platform/codex/receipts.ts';
  if(found==='/upstream/providers/codex/adapter/src/event-normalizer.ts')return '/platform/codex/event-normalizer.ts';
  return found;
}
function collect(id){
  if(sources.has(id))return;sources.set(id,'');
  const source=adaptRuntimeNotifications(id,readSource(id),root);
  const code=id.endsWith('.ts')?ts.transpileModule(source,{fileName:id,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},
    transformers:{before:[context=>node=>ts.visitNode(node,function visit(n){
      if(ts.isMetaProperty(n)&&n.keywordToken===ts.SyntaxKind.ImportKeyword)return ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment('url',ts.factory.createStringLiteral('alma-resource://'+id.replace(/\.ts$/,'.js')))]);
      return ts.visitEachChild(n,visit,context);
    })]}}).outputText:source;
  const map={};for(const m of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)){map[m[1]]=resolve(id,m[1]);collect(map[m[1]]);}
  sources.set(id,code);maps.set(id,map);
  sourceRecords.get(id).moduleSHA256=createHash('sha256').update(code).digest('hex');
}
const providerEntries={codex:'/platform/codex/mobile-provider.ts',kimi:'/platform/kimi/mobile-provider.ts',zcode:'/platform/zcode/mobile-provider.ts'};
const debugExports={CodexEventNormalizerV1:['/platform/codex/event-normalizer.ts','CodexEventNormalizerV1'],resolveCodexNativeProfile:['/upstream/providers/codex/adapter/src/native-profile.ts','resolveCodexNativeProfile'],projectCodexAccountUsage:['/upstream/providers/codex/adapter/src/account-usage.ts','projectCodexAccountUsage'],CodexGuestAdapterV1:['/platform/codex/guest-adapter.ts','CodexGuestAdapterV1']};
const coreRoots=['/vendor/buffer/index.js','/platform/exports.ts','/platform/entry.ts'];
for(const rootID of [...coreRoots,...Object.values(providerEntries),...Object.values(debugExports).map(([id])=>id)])collect(rootID);
function reachable(roots){const seen=new Set();function visit(id){if(seen.has(id))return;seen.add(id);for(const target of Object.values(maps.get(id)))visit(target);}roots.forEach(visit);return seen;}
const core=reachable(coreRoots),providerModules=Object.fromEntries(Object.entries(providerEntries).map(([name,id])=>[name,reachable([id,...(name==='codex'?Object.values(debugExports).map(([id])=>id):[])])]));
for(const id of sources.keys())if(Object.values(providerModules).filter(set=>set.has(id)).length>1)core.add(id);
function definitions(ids){return [...ids].map(id=>`${JSON.stringify(id)}:function(module,exports,require){\n${sources.get(id)}\n}`).join(',\n');}
function moduleMaps(ids){return JSON.stringify(Object.fromEntries([...ids].map(id=>[id,maps.get(id)])));}
const chunks={};
for(const [name,all] of Object.entries(providerModules)){
  const ids=new Set([...all].filter(id=>!core.has(id)));
  const source=`AlmaInstallProviderChunk(${JSON.stringify(name)},{${definitions(ids)}},${moduleMaps(ids)});\n`;
  const filename=`alma-provider-${name}.js`;
  fs.writeFileSync(path.join(out,filename),source);
  chunks[name]={filename,bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex'),modules:[...ids]};
}
const boot=`(function(){'use strict';const modules={${definitions(core)}},maps=${moduleMaps(core)},cache=Object.create(null),loaded=new Set();
function __require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw new Error('Unregistered module '+id);const module={exports:{}};cache[id]=module;try{modules[id](module,module.exports,spec=>__require(maps[id][spec]));}catch(e){delete cache[id];throw e;}return module.exports;}
globalThis.AlmaInstallProviderChunk=function(name,definitions,links){if(loaded.has(name))return;for(const id of Object.keys(definitions)){if(modules[id])throw new Error('Duplicate module '+id);}Object.assign(modules,definitions);Object.assign(maps,links);loaded.add(name);};
function load(name){if(!Object.hasOwn(${JSON.stringify(providerEntries)},name))throw new Error('Unknown provider');if(!loaded.has(name)){if(typeof __almaLoadProviderChunk!=='function'||!__almaLoadProviderChunk(name)||!loaded.has(name))throw new Error('Provider chunk unavailable');}return __require(${JSON.stringify(providerEntries)}[name]);}
globalThis.AlmaLoadProvider=function(name){return load(name)[{codex:'mobileCodexProvider',kimi:'mobileKimiProvider',zcode:'mobileZCodeProvider'}[name]];};
${readSource('/platform/globals.js')}
globalThis.AlmaTAH=__require('/platform/exports.ts');
for(const [name,[id,key]] of Object.entries(${JSON.stringify(debugExports)})){Object.defineProperty(AlmaTAH,name,{get(){load('codex');return __require(id)[key];}});}
__require('/platform/entry.ts');})();\n`;
fs.writeFileSync(path.join(out,'alma-tah.js'),boot);
fs.writeFileSync(path.join(out,'bundle-manifest.json'),JSON.stringify({modules:[...sources.keys()],bytes:Buffer.byteLength(boot),sha256:createHash('sha256').update(boot).digest('hex'),runtimeSiblingImports:false,runtimeNotificationChanges,chunks,coreModules:[...core],
  providerSources,sourceFiles:[...sourceRecords.values()],buildInputs:{typescript:ts.version,
    builderSHA256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    packageLockSHA256:createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL('./package-lock.json',import.meta.url)))).digest('hex')}},null,2)+'\n');
console.log(JSON.stringify({modules:sources.size,bytes:Buffer.byteLength(boot),bundle:path.join(out,'alma-tah.js')}));
