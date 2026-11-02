// Isolated tests of the actual bundled modules. The test-only loader exposure
// changes no module body; no network, credential, native app or model is used.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {adaptRuntimeNotifications} from './runtime_notifications.mjs';
const core = fileURLToPath(new URL('../../shared/tah-runtime/', import.meta.url));
const bundle = process.argv[2] ?? core + 'generated/alma-tah.js';
const source = fs.readFileSync(bundle, 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('bundle-manifest.json', 'file://' + bundle), 'utf8'));
assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sha256);
let hashes = 0;
const sandbox = vm.createContext({setTimeout, clearTimeout, queueMicrotask,
  __almaUUID: randomUUID,
  __almaUTF8ByteLength: value => Buffer.byteLength(value),
  __almaSHA256: value => {hashes++; return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');},
  __almaPlatformCall: async () => {throw new Error('Native access forbidden');}});
vm.runInContext(source.replace('globalThis.AlmaTAH=__require', 'globalThis.testRequire=__require;globalThis.AlmaTAH=__require'), sandbox);
const {AppPresentationTracker} = sandbox.testRequire('/upstream/src/app-runtime/presentation.ts');
const {AppBridgeError} = sandbox.testRequire('/upstream/src/app-runtime/bridge.ts');
const {WorkingStream} = sandbox.testRequire('/platform/working-stream.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const fails = (fn, code) => assert.throws(fn, error => error instanceof AppBridgeError && error.code === code);
const cases = [];
const check = (name, fn) => {fn(); cases.push(name);};
const actionID=randomUUID(), operationID=randomUUID(), scope={role:'actor',round:0};
let tracker = new AppPresentationTracker(), phase='actor', finished=false, reads=0;
let sequence=0;
const event = data => tracker.event(scope, {attemptID:'attempt', sequence:++sequence, ...data});
const view = () => {
  reads++;
  const value=tracker.workingView(phase,finished);
  if (!value) throw new AppBridgeError('unavailable');
  return {actionID,operationID,...value};
};
const stream = new WorkingStream(() => ({workingView: view}));
tracker.stage('actor');
tracker.guardianPassed('Host-owned allowed explanation');
event({kind:'tool_started',toolCallID:'tool',operation:'text_read',detail:'A'});
// These would fail any accidental snapshot/full-log fallback in the accessor.
tracker.snapshot=tracker.workingLog=()=>{throw new Error('Full log/snapshot forbidden during memory read');};
let frame=stream.open({actionID,operationID});
check('Open full reset contract',()=>{
  assert.deepEqual(Object.keys(frame).sort(),['actionID','baseRevision','events','finished','limited','operationID','order','phase','removed','reset','revision','schemaVersion','streamID'].sort());
  assert.equal(frame.baseRevision,0); assert.equal(frame.revision,1); assert.equal(frame.reset,true);
  assert.equal(frame.events.length,2); assert.equal(frame.events[1].detail,'A');
});
const hashBefore=hashes;
check('10,000 busy updates coalesce to one latest bounded upsert',()=>{
  for(let n=1;n<=10000;n++)event({kind:'tool_updated',toolCallID:'tool',detail:'latest-'+n});
  assert.equal(reads,1);
  frame=stream.next({streamID:frame.streamID,afterRevision:frame.revision});
  assert.equal(frame.revision,2); assert.equal(frame.baseRevision,1); assert.equal(frame.reset,false);
  assert.equal(frame.events.length,1); assert.equal(frame.events[0].detail,'latest-10000');
  assert.equal(frame.order.length,2); assert.equal(frame.removed.length,0); assert.equal(hashes,hashBefore);
});
check('Same content and repeated exact ACK keep revision unchanged',()=>{
  event({kind:'tool_updated',toolCallID:'tool',detail:'latest-10000'});
  const expected={unchanged:true,streamID:frame.streamID,revision:2};
  assert.deepEqual(plain(stream.next({streamID:frame.streamID,afterRevision:2})),expected);
  assert.deepEqual(plain(stream.next({streamID:frame.streamID,afterRevision:2})),expected);
  // A consumer cannot alter the stored baseline through its delivered frame.
  frame.events[0].detail='consumer mutation';
  assert.deepEqual(plain(stream.next({streamID:frame.streamID,afterRevision:2})),expected);
});
check('Status-only upsert and stale ACK rejection',()=>{
  event({kind:'tool_completed',toolCallID:'tool',status:'completed',detail:'latest-10000'});
  frame=stream.next({streamID:frame.streamID,afterRevision:2});
  assert.equal(frame.events.length,1); assert.equal(frame.events[0].status,'completed');
  const before=reads;
  fails(()=>stream.next({streamID:frame.streamID,afterRevision:2}),'invalid_request');
  fails(()=>stream.next({streamID:frame.streamID,afterRevision:100}),'invalid_request');
  fails(()=>stream.next({streamID:randomUUID(),afterRevision:3}),'unavailable');
  fails(()=>stream.next({streamID:frame.streamID,afterRevision:3.5}),'invalid_request');
  fails(()=>stream.next({streamID:frame.streamID,afterRevision:Number.MAX_SAFE_INTEGER+1}),'invalid_request');
  fails(()=>stream.open({actionID:'invalid',operationID}),'invalid_request');
  fails(()=>stream.open({actionID,operationID,sourceID:randomUUID()}),'invalid_request');
  assert.equal(reads,before);
});
check('Retention removes evicted IDs and preserves full current order',()=>{
  for(let n=0;n<600;n++)event({kind:'warning',text:'notice-'+n});
  frame=stream.next({streamID:frame.streamID,afterRevision:3});
  assert.equal(frame.revision,4); assert.equal(frame.events.length,511); assert.equal(frame.order.length,512);
  assert.deepEqual(plain(frame.removed),['attempt:tool']); assert.equal(frame.order[0],'extra-safety-pass');
  assert.equal(frame.limited,true);
});
check('Meta-only changes and terminal stopped normalization',()=>{
  phase='critic'; frame=stream.next({streamID:frame.streamID,afterRevision:4});
  assert.equal(frame.events.length,0); assert.equal(frame.revision,5);
  event({kind:'tool_started',toolCallID:'unfinished',operation:'text_read',detail:'last'});
  frame=stream.next({streamID:frame.streamID,afterRevision:5});
  finished=true; phase='completed'; frame=stream.next({streamID:frame.streamID,afterRevision:6});
  assert.equal(frame.finished,true); assert.equal(frame.events.length,1); assert.equal(frame.events[0].status,'stopped');
});
check('Close/reopen and failed Open invalidate the old scope',()=>{
  const old=frame.streamID;
  assert.deepEqual(plain(stream.close({streamID:old})),{closed:true,streamID:old});
  fails(()=>stream.next({streamID:old,afterRevision:7}),'unavailable');
  frame=stream.open({actionID,operationID}); assert.notEqual(frame.streamID,old); assert.equal(frame.revision,1);
  fails(()=>stream.close({streamID:old}),'unavailable');
  fails(()=>stream.open({actionID,operationID:randomUUID()}),'unavailable');
  fails(()=>stream.next({streamID:frame.streamID,afterRevision:1}),'unavailable');
});
check('Visibility and Guardian filtering use existing policy',()=>{
  tracker=new AppPresentationTracker(); finished=false;
  tracker.stage('extra_guardian'); phase='extra_guardian';
  tracker.event({role:'extra_guardian',round:null},{attemptID:'private',sequence:1,kind:'warning',text:'PRIVATE'});
  fails(()=>stream.open({actionID,operationID}),'unavailable');
  tracker.guardianPassed('Public verdict');
  fails(()=>stream.open({actionID,operationID}),'unavailable');
  tracker.stage('actor'); phase='actor'; frame=stream.open({actionID,operationID});
  assert.equal(frame.events.length,1); assert.equal(frame.events[0].id,'extra-safety-pass');
  assert.equal(JSON.stringify(frame).includes('PRIVATE'),false);
  phase='extra_guardian'; fails(()=>stream.next({streamID:frame.streamID,afterRevision:1}),'unavailable');
  phase='actor'; fails(()=>stream.next({streamID:frame.streamID,afterRevision:1}),'unavailable');
});
check('2 MiB text and 4 MiB escaped JSON caps match original workingLog',()=>{
  for(const text of ['x'.repeat(5000), '\t'.repeat(4096), '😀中"\\\n'.repeat(650), '\ud800'.repeat(4096)]) {
    const a=new AppPresentationTracker(), b=new AppPresentationTracker();
    for(let n=1;n<=512;n++){
      const data={attemptID:'limits',sequence:n,kind:'warning',text};
      a.event(scope,data);b.event(scope,data);
    }
    const result=a.workingView('actor',false), legacy=JSON.parse(b.workingLog().text);
    assert.deepEqual(plain(result.events),legacy.events);assert.equal(result.limited,legacy.limited);
    assert.ok(result.events.length<=512);
    assert.ok(result.events.reduce((n,e)=>n+Buffer.byteLength(e.detail),0)<=2*1024*1024);
    assert.ok(Buffer.byteLength(JSON.stringify({schemaVersion:1,limited:result.limited,events:result.events}))<=4*1024*1024);
  }
});
check('Build seams reject source drift in both owned modules',()=>{
  for(const name of ['actions','presentation']) {
    const id=`/upstream/src/app-runtime/${name}.ts`, source=fs.readFileSync(core+id,'utf8');
    assert.throws(()=>adaptRuntimeNotifications(id,source+'\n',core),/adoption drift/);
    const provenance=manifest.runtimeNotificationChanges.find(value=>value.module===id);
    assert.equal(provenance.sourceSHA256,createHash('sha256').update(source).digest('hex'));
  }
});
console.log(JSON.stringify({passed:true,modelCalls:false,realCredentials:false,checks:cases,bundleSHA256:manifest.sha256},null,2));
