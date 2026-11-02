from pathlib import Path
import json, shutil, sys

HERE=Path(__file__).resolve().parent
LAB=HERE.parent
sys.path.insert(0,str(LAB))
from prepare_runtime_rootfs import tree_sha


def main():
    records=list((LAB/'.cache/runtime-rootfs').glob('*/ready.json'))
    if len(records)!=1:raise ValueError('Select exactly one verified prepared runtime')
    root=records[0].parent;data=json.loads(records[0].read_text())
    if tree_sha(root/'fs')!=data['treeSHA256']:raise ValueError('Runtime content changed')
    out=HERE/'.cache/payload'
    if out.exists():
        if tree_sha(out/'fs')!=data['treeSHA256']:raise ValueError('Payload differs from selected runtime')
        return
    out.mkdir(parents=True)
    shutil.copytree(root/'fs',out/'fs')
    (out/'work').mkdir()
    (HERE/'.cache/payload-provenance.json').write_text(json.dumps(data,indent=2)+'\n')


if __name__=='__main__':main()
