#!/usr/bin/env python3
"""Embed existing pinned ICU bytes in an ELF data library for private loader maps."""
from pathlib import Path
import hashlib, json, subprocess
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CACHE = HERE / '.cache'
ready = json.loads((REPO/'tools/mobile-tah/.cache/kimi-packaging-ready.json').read_text())
data = Path(ready['rootfs']) / 'data/usr/share/icu/74.2/icudt74l.dat'
assert hashlib.sha256(data.read_bytes()).hexdigest() == 'ec1035db29767d51df2161dc8dcdb1700140a56e0cc70262444f20c89bed081d', 'Pinned ICU data changed'
assembly = CACHE / 'icu-data.S'
assembly.write_text('.section .rodata,"a",@progbits\n.balign 16\n.global icudt74_dat\n.type icudt74_dat,@object\nicudt74_dat:\n.incbin '+json.dumps(str(data))+'\n.size icudt74_dat, .-icudt74_dat\n.section .note.GNU-stack,"",@progbits\n')
subprocess.run(['/usr/bin/clang','--target=aarch64-linux-musl','-c',str(assembly),'-o',str(CACHE/'icu-data.o')],check=True,timeout=20)
subprocess.run([str(REPO/'tools/alma-ios-lab/.cache/phone-build-bin/ld.lld'),'-shared','--soname=libicudata.so.74','--hash-style=both',str(CACHE/'icu-data.o'),'-o',str(CACHE/'libicudata.so.74.2')],check=True,timeout=20)
report = {'input':str(data),'inputSHA256':hashlib.sha256(data.read_bytes()).hexdigest(),
    'output':str(CACHE/'libicudata.so.74.2'),'outputSHA256':hashlib.sha256((CACHE/'libicudata.so.74.2').read_bytes()).hexdigest(),
    'symbol':'icudt74_dat','alignment':16,'soname':'libicudata.so.74'}
(CACHE/'icu-embedding.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
