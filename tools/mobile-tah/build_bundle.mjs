import ts from 'typescript';
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {adaptRuntimeNotifications,runtimeNotificationChanges} from './runtime_notifications.mjs';
const root=fileURLToPath(new URL('../../shared/tah-runtime/',import.meta.url));
const out=path.join(root,'generated');fs.mkdirSync(out,{recursive:true});
const sources=new Map(),maps=new Map();
const builtins={'node:crypto':'platform/node-crypto.js','node:path':'platform/node-path.js','node:fs/promises':'platform/node-fs-promises.js','node:fs':'platform/unavailable-node-fs.js','node:child_process':'platform/unavailable-node-process.js'};
const packages={zod:'vendor/zod/index.cjs',buffer:'vendor/buffer/index.js','base64-js':'vendor/base64-js/index.js',ieee754:'vendor/ieee754/index.js'};
function resolve(from,spec){
  if(builtins[spec])return '/'+builtins[spec];if(packages[spec])return '/'+packages[spec];
  if(!spec.startsWith('.'))throw new Error('Unmapped runtime dependency: '+spec+' from '+from);
  const target=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));
  const options=[target,target.replace(/\.js$/,'.ts'),target+'/index.ts',target+'/index.cjs'];
  const found=options.find(p=>fs.existsSync(root+p)&&fs.statSync(root+p).isFile());
  if(!found||!['/platform/','/upstream/','/vendor/'].some(p=>found.startsWith(p)))throw new Error('Unresolved closed module '+target);
  if(found==='/upstream/providers/codex/adapter/src/receipts.ts')return '/platform/codex/receipts.ts';
  if(found==='/upstream/providers/codex/adapter/src/event-normalizer.ts')return '/platform/codex/event-normalizer.ts';
  return found;
}
function collect(id){
  if(sources.has(id))return;sources.set(id,'');
  const source=adaptRuntimeNotifications(id,fs.readFileSync(root+id,'utf8'),root);
  const code=id.endsWith('.ts')?ts.transpileModule(source,{fileName:id,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},
    transformers:{before:[context=>node=>ts.visitNode(node,function visit(n){
      if(ts.isMetaProperty(n)&&n.keywordToken===ts.SyntaxKind.ImportKeyword)return ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment('url',ts.factory.createStringLiteral('alma-resource://'+id.replace(/\.ts$/,'.js')))]);
      return ts.visitEachChild(n,visit,context);
    })]}}).outputText:source;
  const map={};for(const m of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)){map[m[1]]=resolve(id,m[1]);collect(map[m[1]]);}
  sources.set(id,code);maps.set(id,map);
}
collect('/vendor/buffer/index.js');collect('/platform/exports.ts');collect('/platform/entry.ts');
const definitions=[...sources].map(([id,code])=>`${JSON.stringify(id)}:function(module,exports,require){\n${code}\n}`).join(',\n');
const boot=`(function(){'use strict';const modules={${definitions}},maps=${JSON.stringify(Object.fromEntries(maps))},cache=Object.create(null);\nfunction __require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw new Error('Unregistered module '+id);const module={exports:{}};cache[id]=module;modules[id](module,module.exports,spec=>__require(maps[id][spec]));return module.exports;}\n${fs.readFileSync(path.join(root,'platform/globals.js'),'utf8')}\nglobalThis.AlmaTAH=__require('/platform/exports.ts');__require('/platform/entry.ts');})();\n`;
fs.writeFileSync(path.join(out,'alma-tah.js'),boot);
fs.writeFileSync(path.join(out,'bundle-manifest.json'),JSON.stringify({modules:[...sources.keys()],bytes:Buffer.byteLength(boot),sha256:createHash('sha256').update(boot).digest('hex'),runtimeSiblingImports:false,runtimeNotificationChanges},null,2)+'\n');
console.log(JSON.stringify({modules:sources.size,bytes:Buffer.byteLength(boot),bundle:path.join(out,'alma-tah.js')}));
