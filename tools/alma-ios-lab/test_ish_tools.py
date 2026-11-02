"""Functional tool replay under iSH. No LLM and no actual generated-note claim."""
from pathlib import Path
import argparse, hashlib, json, re, shutil
from ish_probe import run_case, CACHE, HERE


def setup_work():
    work = CACHE / "ish-work"
    work.mkdir(exist_ok=True)
    source = HERE / ".cache/fixtures/nvidia-source.json"
    turns = json.loads(source.read_text())["turns"]
    payload = {"turns": [{"text": t["text"]} for t in turns], "probe": "中文 English 😀 引号\"和空格"}
    (work / "fixture.json").write_text(json.dumps(payload, ensure_ascii=False))
    lines = "\n".join(t["text"].replace("\n", " ") for t in turns) + "\n"
    (work / "transcript.txt").write_text(lines)
    (work / "python_probe.py").write_text('''import json, re, hashlib, pathlib, os
p=pathlib.Path('/work')
d=json.loads((p/'fixture.json').read_text(encoding='utf-8'))
s='\\n'.join(x['text'] for x in d['turns'])
stats={'turns':len(d['turns']), 'bytes':len(s.encode('utf-8')), 'characters':len(s), 'sha256':hashlib.sha256(s.encode()).hexdigest()}
(p/'python-stats.json').write_text(json.dumps(stats),encoding='utf-8')
dest=p/'中文 notes.md'
tmp=dest.with_suffix('.tmp')
with tmp.open('w',encoding='utf-8') as f:
 f.write('# 工具链 V0\\n'+d['probe']+'\\n'+s+'\\n')
 f.flush();os.fsync(f.fileno())
os.replace(tmp,dest)
text=dest.read_text(encoding='utf-8')
text=re.sub(r'^# 工具链 V0', '# 工具链 V1',text)
dest.write_text(text,encoding='utf-8')
assert '# 工具链 V1' in dest.read_text(encoding='utf-8')
print('PYTHON_TEXT_OK')
''')
    (work / "python_process.py").write_text('''import subprocess,threading,json
out=[]
t=threading.Thread(target=lambda: out.append(42));t.start();t.join(timeout=3)
assert out==[42]
r=subprocess.run(['/bin/sh','-c','printf "child-中文"'],capture_output=True,timeout=5)
assert r.returncode==0 and r.stdout.decode()=='child-中文'
r=subprocess.run(['/bin/cat'],input='stdin 中文 😀'.encode(),capture_output=True,timeout=5)
assert r.returncode==0 and r.stdout.decode()=='stdin 中文 😀'
print('PYTHON_PROCESS_OK')
''')
    (work / "node_probe.cjs").write_text('''const fs=require('node:fs'),crypto=require('node:crypto');
const d=JSON.parse(fs.readFileSync('/work/fixture.json','utf8'));
const s=d.turns.map(t=>t.text).join('\\n');
const stats={turns:d.turns.length,bytes:Buffer.byteLength(s),characters:Array.from(s).length,sha256:crypto.createHash('sha256').update(s).digest('hex')};
fs.writeFileSync('/work/node-stats.json',JSON.stringify(stats));
const name='/work/中文 notes.md';
let note=fs.readFileSync(name,'utf8');
if(!note.startsWith('# 工具链 V1'))throw Error('wrong input');
note=note.replace(/^# 工具链 V1/,'# 工具链 V2')+'\\n## 修改记录\\nNode 已修改；Python 已校验。\\n';
fs.writeFileSync(name+'.tmp',note);fs.renameSync(name+'.tmp',name);
if(fs.readFileSync(name,'utf8')!==note)throw Error('readback');
console.log('NODE_TEXT_OK');
''')
    (work / "node_process.cjs").write_text('''const cp=require('node:child_process');
cp.execFile('/bin/sh',['-c','printf "child-中文"'],{timeout:5000},(err,out)=>{
if(err)throw err;if(out!=='child-中文')throw Error('child output');
setTimeout(()=>console.log('NODE_PROCESS_OK'),10);
});
''')
    joined = "\n".join(t["text"] for t in turns)
    expected = dict(turns=len(turns), bytes=len(joined.encode()), characters=len(joined),
                    sha256=hashlib.sha256(joined.encode()).hexdigest())
    return work, expected


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--phase',choices=['base','install','tools'],required=True)
    p.add_argument('--run',default='v1')
    a=p.parse_args()
    work,expected=setup_work()
    output=CACHE/('tool-suite-'+a.run)
    root=CACHE/('ish-base/fs' if a.phase=='base' else 'ish-augmented/fs')
    if not root.exists():
        root.parent.mkdir(exist_ok=True)
        shutil.copytree(CACHE/'ish-base/fs',root)
    mounts=[f'/work={work}:rw',f'/packages={CACHE/"ish-apks"}:ro']
    cases=[]
    if a.phase=='base':
        cases=[
            ('sed-read',"sed -n '2,4p' /work/transcript.txt > /work/sed-read.txt; test -s /work/sed-read.txt && printf 'SED_READ_OK\\n'",'SED_READ_OK',0),
            ('shell-heredoc',"cat > '/work/shell file.txt' <<'END'\n中文 'single' \"double\" $literal 😀\nEND\nsed -i 's/literal/edited/' '/work/shell file.txt' && grep -q edited '/work/shell file.txt' && printf 'SHELL_EDIT_OK\\n'",'SHELL_EDIT_OK',0),
            ('pipeline',"sed -n '1,20p' /work/transcript.txt | awk 'END {print NR}'",'20',0),
            ('exit-status',"printf 'STDOUT_OK\\n'; printf 'STDERR_OK\\n' >&2; exit 7",'STDOUT_OK',7),
            ('missing-python',"python3 --version",'',127),
            ('missing-node',"node --version",'',127),
        ]
    elif a.phase=='install':
        manifest=json.loads((CACHE/'ish-apks/manifest.json').read_text())
        assert all((CACHE/'ish-apks'/x['filename']).is_file() for x in manifest['packages'])
        cases=[('install-apks',"apk add --no-network /packages/*.apk && printf 'INSTALL_OK\\n'",'INSTALL_OK',0)]
    else:
        cases=[
            ('versions',"python3 --version; node --version; bash --version | head -1",'Python',0),
            ('python-text',"python3 /work/python_probe.py",'PYTHON_TEXT_OK',0),
            ('python-process',"python3 /work/python_process.py",'PYTHON_PROCESS_OK',0),
            ('node-default-text',"node /work/node_probe.cjs",'NODE_TEXT_OK',0),
            ('reset-note',"python3 /work/python_probe.py",'PYTHON_TEXT_OK',0),
            ('node-jitless-text',"node --jitless --no-lazy /work/node_probe.cjs",'NODE_TEXT_OK',0),
            ('node-process',"node --jitless --no-lazy /work/node_process.cjs",'NODE_PROCESS_OK',0),
            ('bash-script',"bash -c 'a=(one two); test ${#a[@]} -eq 2 && printf BASH_OK'",'BASH_OK',0),
            ('sh-bash-array',"sh -c 'a=(one two); printf SHOULD_NOT_PASS'",'',2),
            ('readback',"sed -n '1p' '/work/中文 notes.md'",'# 工具链 V2',0),
            ('same-kernel-repeat',"i=0; while [ $i -lt 3 ]; do python3 /work/python_probe.py && node /work/node_probe.cjs || exit 1; i=$((i+1)); done; printf 'REPEAT_OK\\n'",'REPEAT_OK',0),
        ]
    results=[]
    for name,script,marker,code in cases:
        result=run_case(a.phase+'-'+name,script,root,output,
                        timeout=180 if a.phase=='install' else 45,mounts=mounts)
        observed = result['returncode']==code and result['stopReason'] is None and marker in result['stdout']
        if re.search(r'SAFETY-VALVE|NETDIAG|HOST CRASH|Assertion|Segmentation fault',result['stderr']):observed=False
        checks={}
        if name=='sed-read':
            actual=(work/'sed-read.txt').read_bytes() if (work/'sed-read.txt').exists() else b''
            wanted=b'\n'.join((work/'transcript.txt').read_bytes().splitlines()[1:4])+b'\n'
            checks['exactReadback']=actual==wanted;observed &= checks['exactReadback']
        if name in ['python-text','node-default-text','node-jitless-text']:
            file=work/('python-stats.json' if name=='python-text' else 'node-stats.json')
            checks['corpusStatsMatch']=file.exists() and json.loads(file.read_text())==expected
            observed &= checks['corpusStatsMatch']
        if name in ['readback','same-kernel-repeat']:
            d=json.loads((work/'fixture.json').read_text())
            wanted='# 工具链 V2\n'+d['probe']+'\n'+'\n'.join(t['text'] for t in d['turns'])+'\n\n## 修改记录\nNode 已修改；Python 已校验。\n'
            note=work/'中文 notes.md'
            checks['exactFinalFile']=note.exists() and note.read_bytes()==wanted.encode()
            checks['expectedBytes']=len(wanted.encode())
            observed &= checks['exactFinalFile']
        results.append(dict(id=result['id'],passed=bool(observed),checks=checks,
                            expectedExit=code,exit=result['returncode'],seconds=result['seconds'],
                            stopReason=result['stopReason'],peakSampledRSSBytes=result['peakSampledRSSBytes'],
                            note='Expected unavailable/unsupported behavior' if name.startswith('missing-') or name=='sh-bash-array' else None))
    report=dict(phase=a.phase,results=results,corpusStats=expected,
                scope='Host iSH tool replay only; no Codex inference, no iPhone measurements',
                diagnosticsLocation=str(output))
    summary=HERE/'results'/f'2026-10-31-ish-{a.phase}-{a.run}.json'
    if summary.exists():raise FileExistsError(summary)
    summary.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
