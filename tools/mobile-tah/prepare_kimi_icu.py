"""Embed pinned ICU data using the platform loader's supported private maps."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tempfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_icu(fs, spec):
    data = fs / 'data' / spec['dataPath']
    library = fs / 'data' / spec['libraryPath']
    if sha(data) != spec['dataSHA256'] or sha(library) != spec['embeddedLibrarySHA256']:
        raise ValueError('Embedded ICU data/library differs from its reviewed lock')


def install_icu(fs, spec, linker):
    data = fs / 'data' / spec['dataPath']
    library = fs / 'data' / spec['libraryPath']
    if sha(data) != spec['dataSHA256'] or sha(library) != spec['originalLibrarySHA256']:
        raise ValueError('Original ICU inputs differ from their reviewed lock')
    with tempfile.TemporaryDirectory(prefix='icu-build-', dir=fs.parent) as temporary:
        work = Path(temporary)
        source = work / 'icu-data.S'
        source.write_text('.section .rodata,"a",@progbits\n.balign 16\n'
            '.global icudt74_dat\n.type icudt74_dat,@object\nicudt74_dat:\n'
            '.incbin ' + json.dumps(str(data.resolve())) + '\n'
            '.size icudt74_dat, .-icudt74_dat\n.section .note.GNU-stack,"",@progbits\n')
        obj = work / 'icu-data.o'
        output = work / 'libicudata.so.74.2'
        subprocess.run(['/usr/bin/clang', '--target=aarch64-linux-musl', '-c', str(source), '-o', str(obj)], check=True, timeout=30)
        subprocess.run([str(linker), '-shared', '--soname=libicudata.so.74', '--hash-style=both', str(obj), '-o', str(output)], check=True, timeout=30)
        if sha(output) != spec['embeddedLibrarySHA256']:
            raise ValueError('ICU output changed; review the toolchain before accepting it')
        shutil.copyfile(output, library)
    verify_icu(fs, spec)
