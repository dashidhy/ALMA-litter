#!/usr/bin/env python3
"""Inspect the small ELF ABI surface used by the existing ICU consumer."""
from pathlib import Path
import hashlib
import json
import struct
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CACHE = HERE / '.cache'


def inspect_elf(path):
    blob = path.read_bytes()
    assert blob[:6] == b'\x7fELF\x02\x01', 'Expected ELF64 little endian'
    header = struct.unpack_from('<HHIQQQIHHHHHH', blob, 16)
    kind, machine = header[:2]
    phoff, shoff = header[4:6]
    phentsize, phnum, shentsize, shnum, shstrndx = header[8:13]
    sections = [struct.unpack_from('<IIQQQQIIQQ', blob, shoff + i * shentsize) for i in range(shnum)]
    names_section = sections[shstrndx]
    names = blob[names_section[4]:names_section[4] + names_section[5]]

    def text_at(data, offset):
        return data[offset:data.index(b'\0', offset)].decode()

    by_name = {text_at(names, section[0]): section for section in sections}
    symbols = []
    symbol_bytes = {}
    dynsym = by_name['.dynsym']
    strings = sections[dynsym[6]]
    strings = blob[strings[4]:strings[4] + strings[5]]
    for offset in range(dynsym[4], dynsym[4] + dynsym[5], dynsym[9]):
        name, info, visibility, index, address, size = struct.unpack_from('<IBBHQQ', blob, offset)
        if not name:
            continue
        name = text_at(strings, name)
        symbols.append({'name': name, 'binding': info >> 4, 'type': info & 15,
                        'visibility': visibility & 3, 'defined': index != 0,
                        'address': address, 'size': size})
        if 0 < index < len(sections):
            section = sections[index]
            start = section[4] + address - section[3]
            symbol_bytes[name] = blob[start:start + size]
    dynamic = by_name['.dynamic']
    soname = None
    needed = []
    for offset in range(dynamic[4], dynamic[4] + dynamic[5], 16):
        tag, value = struct.unpack_from('<qQ', blob, offset)
        if tag == 14:
            soname = text_at(strings, value)
        if tag == 1:
            needed.append(text_at(strings, value))
    segments = [struct.unpack_from('<IIQQQQQQ', blob, phoff + i * phentsize) for i in range(phnum)]
    load_segments = [{'flags': p[1], 'address': p[3], 'fileBytes': p[5], 'memoryBytes': p[6], 'alignment': p[7]} for p in segments if p[0] == 1]
    return {'path': str(path), 'sha256': hashlib.sha256(blob).hexdigest(), 'elfType': kind,
            'machine': machine, 'soname': soname, 'needed': needed,
            'symbols': symbols, 'loadSegments': load_segments}, symbol_bytes


ready = json.loads((CACHE / 'packaging-inputs.json').read_text())
root = Path(ready['rootfs']) / 'data'
original, _ = inspect_elf(root / 'usr/lib/libicudata.so.74.2')
replacement, payloads = inspect_elf(CACHE / 'libicudata.so.74.2')
consumer, _ = inspect_elf(root / 'usr/lib/libicuuc.so.74.2')
payload = (root / 'usr/share/icu/74.2/icudt74l.dat').read_bytes()
export = next(s for s in replacement['symbols'] if s['name'] == 'icudt74_dat')
assert replacement['elfType'] == 3 and replacement['machine'] == 183
assert original['soname'] == replacement['soname'] == 'libicudata.so.74'
assert export['defined'] and export['binding'] == 1 and export['type'] == 1 and export['visibility'] == 0
assert export['address'] % 16 == 0 and export['size'] == len(payload)
assert payloads['icudt74_dat'] == payload
assert any(s['name'] == 'icudt74_dat' and not s['defined'] for s in consumer['symbols'])
assert 'libicudata.so.74' in consumer['needed']
original_exports = sorted(s['name'] for s in original['symbols'] if s['defined'] and s['binding'] in (1, 2))
replacement_exports = sorted(s['name'] for s in replacement['symbols'] if s['defined'] and s['binding'] in (1, 2))
assert original_exports == replacement_exports
assert all(not segment['flags'] & 1 for segment in replacement['loadSegments'])
versions = {
    'clang': subprocess.check_output(['/usr/bin/clang', '--version'], text=True).strip(),
    'lld': subprocess.check_output([str(REPO / 'tools/alma-ios-lab/.cache/phone-build-bin/ld.lld'), '--version'], text=True).strip(),
}
report = {'original': original, 'replacement': replacement,
          'consumer': {'path': consumer['path'], 'sha256': consumer['sha256'], 'needed': consumer['needed'],
                       'icuDataSymbol': [s for s in consumer['symbols'] if s['name'] == 'icudt74_dat']},
          'checks': {'identicalExportNames': True, 'identicalSONAME': True, 'payloadByteIdentical': True,
                     'dataOnlyNoExecutableLoadSegments': True, 'consumerImportSatisfied': True},
          'inputDataSHA256': hashlib.sha256(payload).hexdigest(), 'toolVersions': versions}
(CACHE / 'icu-elf-verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
