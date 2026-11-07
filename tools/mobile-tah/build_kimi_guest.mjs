import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../shared/tah-runtime');
const out = path.join(here, '.cache/kimi-guest');
execFileSync('python3', [path.join(here, 'adopt_kimi.py'), '--check-only'], { stdio: 'inherit' });
execFileSync('python3', [path.join(here, 'prepare_sources.py'), '--check-only'], { stdio: 'inherit' });
const sources = new Map(), maps = new Map();
function resolve(from, spec) {
  if (spec.startsWith('node:')) return spec;
  if (spec === 'zod') return '/vendor/zod/index.cjs';
  if (!spec.startsWith('.')) throw new Error(`Unknown guest dependency ${spec}`);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const found = [target, target.replace(/\.js$/, '.ts')].find(file => fs.existsSync(root + file));
  if (!found || !['/platform/kimi/', '/upstream/', '/vendor/'].some(prefix => found.startsWith(prefix))) throw new Error(`Unknown guest module ${target}`);
  return found;
}
function collect(id) {
  if (sources.has(id) || id.startsWith('node:')) return;
  sources.set(id, '');
  const source = fs.readFileSync(root + id, 'utf8');
  const code = id.endsWith('.ts') ? ts.transpileModule(source, { fileName: id,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText : source;
  const map = {};
  for (const match of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
    map[match[1]] = resolve(id, match[1]);
    collect(map[match[1]]);
  }
  sources.set(id, code);
  maps.set(id, map);
}
for (const id of ['/platform/kimi/guest/runner.ts', '/platform/kimi/guest/pipe-fetch.ts']) collect(id);
const definitions = [...sources].map(([id, code]) => `${JSON.stringify(id)}:function(module,exports,require){\n${code}\n}`).join(',\n');
const bootstrap = `import {createRequire as __createRequire} from 'node:module';
const __nativeRequire=__createRequire(import.meta.url),__modules={${definitions}},__maps=${JSON.stringify(Object.fromEntries(maps))},__cache=Object.create(null);
function __require(id){if(id.startsWith('node:'))return __nativeRequire(id);if(__cache[id])return __cache[id].exports;if(!__modules[id])throw new Error('Unknown guest module '+id);const module={exports:{}};__cache[id]=module;__modules[id](module,module.exports,spec=>__require(__maps[id][spec]));return module.exports;}
`;
const entry = fs.readFileSync(path.join(root, 'platform/kimi/guest/entry.mjs'), 'utf8')
  .replace("import { parseStart, runKimiGuest } from './runner.js';", "const {parseStart,runKimiGuest}=__require('/platform/kimi/guest/runner.ts');")
  .replace("import { createPipeFetch } from './pipe-fetch.js';", "const {createPipeFetch}=__require('/platform/kimi/guest/pipe-fetch.ts');");
const bundle = bootstrap + entry;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'guest.mjs'), bundle);
const manifest = { format: 'esm', sha256: createHash('sha256').update(bundle).digest('hex'), bytes: Buffer.byteLength(bundle),
  modules: [...sources.keys()], sdkImport: './sdk/index.mjs',
  compatibilityPackages: { 'node-fetch': '3.3.2', 'data-uri-to-buffer': '4.0.1', 'fetch-blob': '3.2.0',
    'formdata-polyfill': '4.0.10', 'node-domexception': '1.0.0', 'web-streams-polyfill': '3.3.3' } };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ guest: path.join(out, 'guest.mjs'), ...manifest }));
