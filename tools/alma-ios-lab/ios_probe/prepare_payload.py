"""Bundle pristine fakefs, verified signed APKs and the same host test fixtures."""
from pathlib import Path
import hashlib, json, shutil, sys, tarfile

HERE=Path(__file__).resolve().parent
LAB=HERE.parent
CACHE=LAB/'.cache'


def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def main(payload=None):
    sys.path.insert(0,str(LAB))
    from test_ish_tools import setup_work
    setup_work()  # Only prepares inputs/scripts; never launches host tools.
    commands=json.loads((HERE/'commands.json').read_text())
    payload=payload or HERE/'.cache/payload'
    payload.mkdir(parents=True,exist_ok=False)
    archive=CACHE/'litter-rootfs-v0.1.2.tar.gz'
    assert sha(archive)=='70e7d8acc9520ca45d53821dd3ffab1035620156dda3e513e66013e848f6ba0a'
    with tarfile.open(archive) as a:a.extractall(payload,filter='data')
    work=payload/'work';work.mkdir()
    for name in ['fixture.json','transcript.txt','python_probe.py','python_process.py','node_probe.cjs','node_process.cjs']:
        shutil.copyfile(CACHE/'ish-work'/name,work/name)
    packages=payload/'packages';packages.mkdir()
    lock=json.loads((LAB/'results/2026-10-31-ish-package-lock.json').read_text())
    for item in lock['packages']:
        source=CACHE/'ish-apks'/item['filename'];assert sha(source)==item['sha256']
        shutil.copyfile(source,packages/item['filename'])
    expected=json.loads((LAB/'results/2026-10-31-ish-tools-full-text-v4.json').read_text())['corpusStats']
    d=json.loads((work/'fixture.json').read_text())
    final='# 工具链 V2\n'+d['probe']+'\n'+'\n'.join(t['text'] for t in d['turns'])+'\n\n## 修改记录\nNode 已修改；Python 已校验。\n'
    cases=[]
    def add(id,script,marker,exit=0,timeout=60000,checks=None,limitation=False):
        cases.append(dict(id=id,script=script,marker=marker,expected_exit=exit,timeout_ms=timeout,
                          checks=checks or [],expected_limitation=limitation))
    for name,marker in [('sed-read','SED_READ_OK'),('shell-heredoc','SHELL_EDIT_OK'),('pipeline','20')]:
        checks=[]
        if name=='sed-read':
            result=b'\n'.join((work/'transcript.txt').read_bytes().splitlines()[1:4])+b'\n'
            checks=[dict(file='sed-read.txt',sha256=hashlib.sha256(result).hexdigest())]
        add('base-'+name,commands['base-'+name],marker,checks=checks)
    add('exit-seven',"printf 'OUT_OK\\n'; printf 'ERR_OK\\n' >&2; exit 7",'ERR_OK',exit=7)
    add('missing-python',"python3 --version",'not found',exit=127,limitation=True)
    add('install',"apk add --no-network /packages/*.apk && printf 'INSTALL_OK\\n'",'INSTALL_OK',timeout=180000)
    tags={'versions':'Python','python-text':'PYTHON_TEXT_OK','python-process':'PYTHON_PROCESS_OK',
          'node-default-text':'NODE_TEXT_OK','reset-note':'PYTHON_TEXT_OK','node-jitless-text':'NODE_TEXT_OK',
          'node-process':'NODE_PROCESS_OK','bash-script':'BASH_OK','sh-bash-array':'',
          'readback':'# 工具链 V2','same-kernel-repeat':'REPEAT_OK'}
    for name,marker in tags.items():
        checks=[]
        if name in ['python-text','node-default-text','node-jitless-text']:
            checks=[dict(file='python-stats.json' if name=='python-text' else 'node-stats.json',json=expected)]
        if name in ['readback','same-kernel-repeat']:
            checks=[dict(file='中文 notes.md',sha256=hashlib.sha256(final.encode()).hexdigest())]
        add(name,commands[name],marker,exit=2 if name=='sh-bash-array' else 0,
            checks=checks,limitation=name=='sh-bash-array')
    add('identities',commands['identities'],'linux')
    (payload/'plan.json').write_text(json.dumps(dict(cases=cases),ensure_ascii=False,indent=2)+'\n')
    record={'cases':len(cases),'payloadBytes':sum(p.stat().st_size for p in payload.rglob('*') if p.is_file()),
            'planSHA256':sha(payload/'plan.json'),'inputSHA256':sha(work/'fixture.json'),
            'scope':'Same host scripts and text; fresh on-device rootfs and apk install; includes expected missing-tool/sh-syntax controls'}
    (HERE/'.cache/payload-provenance.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record,indent=2))


if __name__=='__main__':main()
