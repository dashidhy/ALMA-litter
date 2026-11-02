"""Explicitly adopt current Mac-owned TAH source into mobile ownership.
No runtime or shipping bundle may import the sibling Mac repository.
"""
from pathlib import Path
import argparse,hashlib,json,shutil,subprocess

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
SOURCE=REPO.parent/'ALMA/app/TAH'
DEST=REPO/'shared/tah-runtime/upstream'
LOCK=REPO/'shared/tah-runtime/source-lock.json'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only',action='store_true',help='Verify the committed mobile-owned snapshot without a sibling Mac checkout')
    args=parser.parse_args()
    if args.check_only:
        if not LOCK.is_file():raise RuntimeError('Missing owned source lock')
        records=json.loads(LOCK.read_text())['files']
        actual={str(p.relative_to(DEST)) for p in DEST.rglob('*') if p.is_file()}
        if actual!=set(records):raise RuntimeError('Owned source inventory differs from its lock')
        for rel,digest in records.items():
            if sha(DEST/rel)!=digest:raise RuntimeError(f'Owned source hash mismatch: {rel}')
        print(json.dumps({'verified':True,'files':len(records),'bytes':sum((DEST/r).stat().st_size for r in records),'siblingCheckoutRequired':False}))
        return
    paths=[]
    for directory in ['src','prompts','providers/codex/adapter/src']:
        paths.extend(p for p in (SOURCE/directory).rglob('*') if p.is_file() and p.suffix in ['.ts','.txt','.json'])
    paths += [SOURCE/'providers/codex/app-profile.json',SOURCE/'package.json',SOURCE/'package-lock.json']
    records={str(p.relative_to(SOURCE)):sha(p) for p in sorted(set(paths))}
    if LOCK.exists():
        old=json.loads(LOCK.read_text())
        if records!=old['files']:raise RuntimeError('Mac source drift; explicit review is required before adoption')
        for rel,digest in records.items():
            if not (DEST/rel).is_file() or sha(DEST/rel)!=digest:raise RuntimeError('Owned source changed; refusing overwrite')
    else:
        if DEST.exists() and any(DEST.iterdir()):raise RuntimeError('Destination is not empty')
        for path in paths:
            target=DEST/path.relative_to(SOURCE);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
        LOCK.write_text(json.dumps({'source':str(SOURCE),'gitHead':subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip(),
            'ownership':'Explicit reviewed source adoption; mobile bundle uses this owned snapshot only. Platform adapters live outside upstream.',
            'files':records},indent=2)+'\n')
    print(json.dumps({'files':len(records),'bytes':sum((DEST/r).stat().st_size for r in records),'destination':str(DEST)}))

if __name__=='__main__':main()
