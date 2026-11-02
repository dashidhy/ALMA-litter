#!/usr/bin/env python3
"""Resolve proposed target trees in an owned workspace copy; never compile it."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
TOOL=ROOT.parent/'ALMA/.build/tauri-toolchain'
BIN=TOOL/'rustup/toolchains/stable-aarch64-apple-darwin/bin'
cache=HERE/'.cache'; cache.mkdir(exist_ok=True)
shadow=Path(tempfile.mkdtemp(prefix='trees-',dir=cache))
(shadow/'shared').mkdir()
shutil.copytree(ROOT/'shared/rust-bridge',shadow/'shared/rust-bridge',ignore=shutil.ignore_patterns('target','generated','.git'))
(shadow/'shared/third_party').symlink_to(ROOT/'shared/third_party',target_is_directory=True)
(shadow/'.build').symlink_to(ROOT/'.build',target_is_directory=True)
for path in (HERE/'after/shared/rust-bridge').rglob('*'):
    if path.is_file():
        target=shadow/path.relative_to(HERE/'after'); target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(path,target)
env=dict(os.environ,CARGO_HOME=str(TOOL/'cargo'),RUSTC=str(BIN/'rustc'))
rows=[]
interesting={'codex-mobile-client','iroh','iroh-relay','netwatch','netdev','portmapper','reqwest','hyper','tokio','codex-core','codex-app-server','codex-web-search-extension','codex-slingshot'}
for target,local in [('aarch64-apple-ios',False),('aarch64-apple-ios',True),('aarch64-apple-darwin',False),('aarch64-linux-android',False)]:
    command=[str(BIN/'cargo'),'tree','--manifest-path',str(shadow/'shared/rust-bridge/Cargo.toml'),'--offline','--target',target,'-p','codex-mobile-client','-e','normal,build','--prefix','none','-f','{p} features=[{f}]']
    if local:command+=['--no-default-features']
    result=subprocess.run(command,env=env,text=True,capture_output=True,timeout=60)
    label=target+('-local' if local else '-default')
    log=shadow/f'{label}.txt'; log.write_text(result.stdout+result.stderr)
    lines=sorted(set(line.removesuffix(' (*)') for line in result.stdout.splitlines() if line.split(' ',1)[0] in interesting))
    row={'target':target,'local':local,'exit_code':result.returncode,'log':str(log),'selected':lines}
    if result.returncode:
        row['error']=result.stderr
    elif local:
        names={line.split(' ',1)[0] for line in result.stdout.splitlines()}
        assert not names.intersection({'iroh','iroh-relay','netwatch','netdev','portmapper'})
        assert {'reqwest','hyper','tokio','codex-core','codex-app-server','codex-web-search-extension'}.issubset(names)
        assert any(line.startswith('reqwest v0.12.') and 'rustls-tls' in line and 'json' in line and 'stream' in line for line in lines)
        row['assertions']='remote stack absent; local Codex, Web extension and reqwest 0.12 native TLS remain'
    else:
        assert any(line.startswith('iroh v1.0.3') for line in lines)
    (HERE/f'tree-{label}.txt').write_text(' '.join(command)+'\n'+'\n'.join(lines)+'\n'+(result.stderr if result.returncode else ''))
    rows.append(row)
    print(label,result.returncode,flush=True)
(HERE/'tree-summary.json').write_text(json.dumps(rows,indent=2)+'\n')
