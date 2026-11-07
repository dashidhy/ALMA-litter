#!/usr/bin/env python3
"""Build and run an exact isolated owned-host snapshot with production grants."""
from pathlib import Path
import hashlib, json, os, shutil, signal, subprocess, sys, time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CACHE = HERE / '.cache'
TOOLCHAIN = REPO.parent / 'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin'
CACHE.mkdir(exist_ok=True)

def bounded(command, label, timeout, env=None):
    start = time.monotonic()
    peak = 0
    with (CACHE / f'{label}.stdout').open('w') as out, (CACHE / f'{label}.stderr').open('w') as err:
        process = subprocess.Popen(command, cwd=HERE, env=env, stdout=out, stderr=err, start_new_session=True)
        failure = None
        while process.poll() is None:
            rows = subprocess.check_output(['ps', '-axo', 'pid=,pgid=,rss='], text=True)
            rss = [int(row.split()[2]) for row in rows.splitlines() if len(row.split()) == 3 and int(row.split()[1]) == process.pid]
            peak = max([peak, *rss])
            if peak > 1800 * 1024:
                failure = 'RSS limit 1800 MiB'
            if time.monotonic() - start > timeout:
                failure = 'deadline'
            if failure:
                os.killpg(process.pid, signal.SIGKILL)
                break
            time.sleep(0.2)
        code = process.wait()
    stderr = (CACHE / f'{label}.stderr').read_text()
    guest = next((json.loads(line.removeprefix('PROBE_RESULT ')) for line in stderr.splitlines() if line.startswith('PROBE_RESULT ')), None)
    result = {'guest': guest, 'label': label, 'returncode': code, 'seconds': time.monotonic()-start, 'peakProcessRSSKiB': peak, 'failure': failure}
    (CACHE / f'{label}.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result), flush=True)
    print((CACHE / f'{label}.stderr').read_text()[-6000:], flush=True)
    if 'success' in label and (not guest or guest.get('exitCode') != 0 or not guest.get('closed') or guest.get('terminal', {}).get('kind') != 'end_turn'):
        return 1
    return code

if sys.argv[1] == 'build':
    source = REPO / '.build/vendor/litter-ish-owned'
    target = CACHE / 'owned-source'
    if not target.exists():
        shutil.copytree(source, target, symlinks=True)
        hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
        assert all(hashlib.sha256((target/p).read_bytes()).hexdigest() == h for p,h in hashes.items())
        (CACHE / 'source-sha256.json').write_text(json.dumps(hashes, indent=2)+'\n')
        # Resolve host and supervisor dependencies in private offline lockfiles.
        (target / 'embed/Cargo.lock').unlink()
    cargo_home = CACHE / 'cargo-home'
    cargo_home.mkdir(exist_ok=True)
    registry = REPO.parent / 'ALMA/.build/tauri-toolchain/cargo/registry'
    for name in ['index', 'cache']:
        destination = cargo_home / 'registry' / name
        if not destination.exists(): shutil.copytree(registry / name, destination)
    (cargo_home / 'config.toml').write_text('[net]\noffline=true\n')
    env = dict(os.environ, CARGO_HOME=str(cargo_home), CARGO_TARGET_DIR=str(CACHE/'target'), CARGO_BUILD_JOBS='1',
        RUSTC=str(TOOLCHAIN/'bin/rustc'), RUSTDOC=str(TOOLCHAIN/'bin/rustdoc'),
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=str(REPO/'tools/alma-ios-lab/.cache/phone-build-bin/rust-lld'),
        LIBCLANG_PATH='/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib',
        DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer', RUSTC_WRAPPER='', CARGO_INCREMENTAL='0')
    env['PATH'] = os.pathsep.join([str(REPO/'tools/alma-ios-lab/.cache/phone-build-bin'), str(REPO/'tools/alma-ios-lab/.cache/ish-tools/bin'), str(TOOLCHAIN/'bin'), env['PATH']])
    sys.exit(bounded([str(TOOLCHAIN/'bin/cargo'), 'build', '--offline', '-j', '1'], 'build', 600, env))

mode = sys.argv[1]
ready = json.loads((CACHE/('integrated-inputs.json' if mode.startswith('tools-') else 'packaging-inputs.json')).read_text())
rootfs = CACHE / f'fs-{mode}'
workspace = CACHE / f'workspace-{mode}'
if not rootfs.exists(): shutil.copytree(ready['rootfs'], rootfs, symlinks=True)
if 'embedded' in mode:
    shutil.copyfile(CACHE/'libicudata.so.74.2', rootfs/'data/usr/lib/libicudata.so.74.2')
view = workspace / 'attempts/probe/view'
scratch = workspace / 'attempts/probe/scratch'
view.mkdir(parents=True, exist_ok=True)
scratch.mkdir(parents=True, exist_ok=True)
if (scratch/'home').exists(): shutil.rmtree(scratch/'home')
if mode.startswith('diagnostic'):
    (workspace/'outside-grant.txt').write_text('SYNTHETIC_OUTSIDE_GRANT')
    escape = scratch/'escape'
    if escape.is_symlink(): escape.unlink()
runtime = workspace / '.runtime/kimi'
if not runtime.exists(): shutil.copytree(ready['resource'], runtime)
def write_guest(content):
    path = runtime / 'guest.mjs'
    mode_bits = path.stat().st_mode
    path.chmod(mode_bits | 0o200)
    try:
        path.write_text(content)
    finally:
        path.chmod(mode_bits)

if mode == 'trace':
    guest = (REPO/'tools/mobile-tah/.cache/kimi-guest/guest.mjs').read_text()
    needle = 'function reportFatal(error) {'
    assert needle in guest
    guest = guest.replace(needle, needle + "\n  writeSync(2, 'PROBE_FATAL ' + JSON.stringify({name:error?.name,code:error?.code,message:error?.message,stack:error?.stack}) + '\\n');")
    write_guest(guest)

if 'realpath' in mode:
    guest = (runtime/'guest.mjs').read_text()
    marker = 'syncBuiltinESMExports();'
    shim = "const __probeFS = __nativeRequire('node:fs');\n__probeFS.promises.realpath = __nativeRequire('node:util').promisify(__probeFS.realpath);\n"
    assert marker in guest
    if shim not in guest:
        write_guest(guest.replace(marker, shim + marker))
attempt = {'contractVersion':1, 'attemptID':'00000000-0000-4000-8000-000000000001', 'providerID':'kimi', 'role':'raw_guardian',
    'inference':{'modelID':'kimi-for-coding','reasoningEffortID':'low'},
    'prompt':[{'authority':'tah_instruction','text':'Return JSON with safe true.'}],
    'workspace':{'materials':[],'candidateSeeds':[],'writableRoots':[]},
    'responseExpectation':{'kind':'strict_json','schemaID':'fixture/v1','maximumUTF8Bytes':4096},
    'requiredAbilities':['prompt.inline_text','workspace.entries.list','workspace.text.read','workspace.text.search']}
plan = {'steps': [], 'finalText': '{"safe":true}'}
material = 'ALMA_OWNED_TOOL_FIXTURE: Alice Friday, Bob Thursday, budget 500. 中文 🧪\n'
output = '# Notes\nAlice Friday. Bob Thursday. Budget 500. 中文 🧪\n'
if mode.startswith('tools-'):
    (view/'input.txt').write_text(material)
    attempt['workspace']['materials'] = [{'relativePath':'input.txt','mediaType':'text/plain',
        'byteLength':len(material.encode()),'sha256':hashlib.sha256(material.encode()).hexdigest()}]
    attempt['prompt'][0]['text'] = 'Read input.txt, list matching files, and search ALMA_OWNED_TOOL_FIXTURE. Return JSON for Guardian. Write outbox/notes.md for Actor.'
    guest_view = '/workspace/attempts/probe/view'
    plan['steps'] = [
        {'name':'Read','arguments':{'path':guest_view+'/input.txt'},'expected':['ALMA_OWNED_TOOL_FIXTURE','中文 🧪']},
        {'name':'Glob','arguments':{'path':guest_view,'pattern':'*.txt'},'expected':['input.txt']},
        {'name':'Grep','arguments':{'path':guest_view,'pattern':'ALMA_OWNED_TOOL_FIXTURE','output_mode':'content'},'expected':['input.txt','ALMA_OWNED_TOOL_FIXTURE']},
    ]
    if 'actor' in mode:
        (view/'outbox').mkdir(exist_ok=True)
        if (view/'outbox/notes.md').exists(): (view/'outbox/notes.md').unlink()
        attempt['role'] = 'actor'
        attempt['workspace']['writableRoots'] = ['outbox']
        attempt['requiredAbilities'] += ['workspace.text.write','workspace.text.edit']
        attempt['responseExpectation'] = {'kind':'workspace_outcome','contractID':'fixture/v1','maximumFinalMessageUTF8Bytes':4096}
        plan['finalText'] = 'Done 中文 🧪.'
        plan['steps'] += [
            {'name':'Write','arguments':{'path':guest_view+'/outbox/notes.md','content':output},'expected':[]},
            {'name':'Read','arguments':{'path':guest_view+'/outbox/notes.md'},'expected':['Budget 500.']},
            {'name':'Edit','arguments':{'path':guest_view+'/outbox/notes.md','old_string':'Budget 500.','new_string':'Budget 500 dollars.'},'expected':[]},
            {'name':'Read','arguments':{'path':guest_view+'/outbox/notes.md'},'expected':['Budget 500 dollars.']},
        ]
fixture = CACHE / f'{mode}-start.jsonl'
fixture.write_text(json.dumps({'kind':'start','attempt':attempt,'workspaceRoot':'/workspace/attempts/probe/view','scratchRoot':'/workspace/attempts/probe/scratch'})+'\n')
plan_path = CACHE / f'{mode}-plan.json'
plan_path.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
(CACHE / f'{mode}-inputs.json').write_text(json.dumps({'packaging':ready,'guestSHA256':hashlib.sha256((runtime/'guest.mjs').read_bytes()).hexdigest(),'fixtureSHA256':hashlib.sha256(fixture.read_bytes()).hexdigest()}, indent=2)+'\n')
code = bounded([str(CACHE/'target/debug/kimi-owned-probe'),str(rootfs/'data'),str(workspace),mode,str(HERE/'diagnostic.cjs' if mode.startswith('diagnostic') else fixture),str(plan_path)], mode, 115)
if mode.startswith('tools-'):
    frames = [json.loads(line.removeprefix('__ALMA_KIMI__')) for line in (CACHE/f'{mode}.stdout').read_text().splitlines() if line.startswith('__ALMA_KIMI__')]
    events = [frame['event'] for frame in frames if frame['kind']=='event']
    requests = [json.loads(frame['body']) for frame in frames if frame['kind']=='http']
    checks = []
    for index, step in enumerate(plan['steps'], 1):
        following = requests[index] if index < len(requests) else {}
        tool = next((message for message in following.get('messages',[]) if message.get('role')=='tool' and message.get('tool_call_id')==f'tool-{index}'), None)
        content = json.dumps(tool,ensure_ascii=False) if tool else ''
        checks.append({'tool':step['name'],'id':f'tool-{index}','resultReturned':tool is not None,
            'expectedContentsPresent':all(text in content for text in step['expected'])})
    terminal = next((frame['terminal'] for frame in frames if frame['kind']=='terminal'), {})
    final_id = terminal.get('finalMessageID')
    final_text = ''.join(event['text'] for event in events if event['kind']=='message_delta' and event['messageID']==final_id)
    operation_names = {'Read':'text_read','Glob':'workspace_list','Grep':'text_search','Write':'text_write','Edit':'text_edit'}
    operations = [event['operation'] for event in events if event['kind']=='tool_started']
    completed = [event for event in events if event['kind']=='tool_completed']
    validation = {'steps':checks,'operations':operations,'requests':len(requests),'events':len(events),
        'expectedOperations':operations == [operation_names[step['name']] for step in plan['steps']],
        'toolCompletionsPassed':len(completed)==len(plan['steps']) and all(event['status']=='completed' for event in completed),
        'inputUnchanged':(view/'input.txt').read_text()==material,'privateHomeRemoved':not (scratch/'home').exists(),
        'sequencesContiguous':[event['sequence'] for event in events]==list(range(1,len(events)+1)),
        'finalAnswerMatches':terminal.get('finalText')==plan['finalText']==final_text,
        'httpAcknowledged':sum(frame['kind']=='httpAck' for frame in frames)==len(requests),
        'guestUnmodified':(runtime/'guest.mjs').read_bytes()==(Path(ready['resource'])/'guest.mjs').read_bytes()}
    if 'actor' in mode:
        validation['outputMatches'] = (view/'outbox/notes.md').exists() and (view/'outbox/notes.md').read_text()==output.replace('Budget 500.','Budget 500 dollars.')
    validation['passed'] = code==0 and len(requests)==len(plan['steps'])+1 and all(step['resultReturned'] and step['expectedContentsPresent'] for step in checks) and all(value for value in validation.values() if isinstance(value,bool))
    (CACHE/f'{mode}-validation.json').write_text(json.dumps(validation,indent=2)+'\n')
    print(json.dumps(validation),flush=True)
    if not validation['passed']: code=1
sys.exit(code)
