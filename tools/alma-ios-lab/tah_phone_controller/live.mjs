// Explicit qualification entry point; imports alone never touch a device.
import { createServer } from '../../../../ALMA/app/TAH/node_modules/vite/dist/node/index.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const mode=process.argv[2], output=process.argv[3];
if (!['validate','inspect','run'].includes(mode) || !output) throw new Error('Usage: node live.mjs validate|inspect|run NEW_OUTPUT_DIRECTORY');
const here=fileURLToPath(new URL('.',import.meta.url));
const root=resolve(output); await mkdir(root,{recursive:false,mode:0o700});
const profileFile=resolve(here,'../local_agent_probe/.build/bound/qualification-profile.json');
const profile=JSON.parse(await readFile(profileFile,'utf8'));
const abort=new AbortController();
process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
const server=await createServer({configFile:false,root:here,cacheDir:join(here,'.live-cache'),
  appType:'custom',server:{middlewareMode:true,hmr:false,watch:null},logLevel:'error'});
let journal;
try {
  const {createPhonePort}=await server.ssrLoadModule('/phone-port.ts');
  const phone=createPhonePort({workRoot:join(root,'transport'),profileFile,expectedProfileDigest:profile.digest});
  let result;
  if (mode==='validate') {
    const {loadFixture}=await server.ssrLoadModule('/controller.ts');
    await loadFixture();
    console.log(JSON.stringify({validation:'passed',deviceCalls:0,output:root}));
  } else if (mode==='inspect') {
    result=await phone.inspect(abort.signal);
    await writeFile(join(root,'binding.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({inspection:'passed',modelCount:result.catalog.models.length,output:root}));
  } else {
    const {createFileJournal}=await server.ssrLoadModule('/file-journal.ts');
    const {runQualification}=await server.ssrLoadModule('/controller.ts');
    journal=createFileJournal(join(root,'journal'));
    const observed={...phone,runFresh:async(request,event,signal)=>{
      console.log(JSON.stringify({event:'attempt-start',role:request.built.attempt.role,attemptID:request.built.attempt.attemptID,
        model:request.built.attempt.inference.modelID,writableRoots:request.built.attempt.workspace.writableRoots}));
      try { return await phone.runFresh(request,event,signal); }
      catch(error) {
        console.log(JSON.stringify({event:'attempt-port-failed',role:request.built.attempt.role,
          code:typeof error?.code==='string'?error.code:'unclassified'}));
        throw error;
      }
    },admitReaped:async(receipt,request)=>{
      const result=await phone.admitReaped(receipt,request);
      console.log(JSON.stringify({event:'attempt-reaped',role:request.built.attempt.role,terminal:result.result.terminal.kind}));
      return result;
    }};
    result=await runQualification({modelID:'gpt-6.1-sol',reasoningEffortID:null},observed,journal,abort.signal);
    await writeFile(join(root,'result.json'),JSON.stringify(result,(_,v)=>v instanceof Map?{mapEntries:[...v]}:
      v instanceof Uint8Array?{base64:Buffer.from(v).toString('base64')}:v,2)+'\n',{flag:'wx',mode:0o600});
    const completed=Array.isArray(result.accepted)&&result.accepted.length===3;
    console.log(JSON.stringify({qualification:completed?'passed':'incomplete',acceptedRevisions:result.accepted?.length??0,output:root}));
    if(!completed)process.exitCode=1;
  }
} catch(error) {
  // No raw command/provider bodies or account data on the terminal.
  const code=typeof error?.code==='string'?error.code:'qualification_failed';
  await writeFile(join(root,'failure.json'),JSON.stringify({code,aborted:abort.signal.aborted})+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({outcome:'failed',code,output:root}));process.exitCode=1;
} finally {journal?.close();await server.close();}
