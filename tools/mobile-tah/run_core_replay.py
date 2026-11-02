"""Reproduce the model-free original-core/JSCore/SQLite compatibility check."""
from pathlib import Path
import json, subprocess, tempfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
CORE=REPO/'shared/tah-runtime'
CACHE=HERE/'.cache';CACHE.mkdir(exist_ok=True)
subprocess.run(['node',str(HERE/'build_bundle.mjs')],cwd=REPO,check=True)
value=json.loads((HERE/'fixtures/core-replay.json').read_text())
prompts=CORE/'upstream/prompts'
profile=json.loads((CORE/'upstream/providers/codex/app-profile.json').read_text())
profile['profileIdentity']='1'*64  # deliberately synthetic, no credential/model call
value['config']={'profiles':[profile],'actionInstructions':(prompts/'action_instructions/structured_notes_v4_3.txt').read_text(),
  'resources':{key:(prompts/'system_prompts'/name).read_text()for key,name in {
    'actorPromptTemplate':'actor_prompt_v4_2.txt','rawGuardianPrompt':'safety_guardian_raw_prompt_v0_3.txt',
    'extraGuardianPrompt':'safety_guardian_extra_prompt_v0_6.txt','safetyPolicy':'safety_guardian_policy_v0_2.txt'}.items()}}
input_path=CACHE/'replay-input.json';input_path.write_text(json.dumps(value))
app=REPO/'apps/ios/Sources/AlmaTAH'
binary=CACHE/'core-replay'
sources=[app/'Runtime/AlmaTAHJavaScriptHost.swift',app/'Runtime/TAHJavaScriptBytePrimitives.swift',*sorted((app/'Persistence').glob('TAH*.swift')),HERE/'core_replay.swift']
subprocess.run(['xcrun','swiftc','-swift-version','6','-strict-concurrency=complete','-parse-as-library',
               *map(str,sources),'-lsqlite3','-o',str(binary)],check=True)
with tempfile.TemporaryDirectory(prefix='core-replay-',dir=CACHE) as temp:
    output=subprocess.check_output([str(binary),str(CORE/'generated/alma-tah.js'),str(HERE/'core_replay.js'),str(input_path),str(Path(temp)/'journal')],text=True,timeout=60)
report=json.loads(output)
assert report['passed'] and report['modelCalls'] is False
assert [step['role']for step in report['calls']]==['raw_guardian','actor','extra_guardian','actor','extra_guardian','actor']
assert [step['revisions']for step in report['outcomes']]==[1,2,3]
assert len(report['workingLogs'])==3 and report['previousLogStillReadable']
assert all(step['parts']>=2 and step['wrongHashRejected']for step in report['workingLogs'])
(CACHE/'latest-core-replay.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'modelCalls':False,'publishedRevisions':3,'checkedOutputFiles':6,'verifiedMultiChunkWorkingLogs':3}))
