#!/usr/bin/env python3
"""Prepare local iOS linker wrappers; no builds or implicit downloads.

--check-only reads files only. --install-targets explicitly permits rustup to
download missing standard libraries into the selected existing toolchain.
"""
from pathlib import Path
import argparse
import json
import os
import shlex
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = HERE / '.cache/phone-build-bin'
TOOLCHAIN = 'stable-aarch64-apple-darwin'
TARGETS = ('aarch64-apple-ios', 'aarch64-unknown-linux-musl')
XCODE = Path('/Applications/Xcode.app/Contents/Developer')


def wrappers(lib):
    result = {}
    for name, extra in [('ld.lld', '-flavor gnu '), ('rust-lld', '')]:
        result[name] = ('#!/bin/sh\nexport DYLD_LIBRARY_PATH=' + shlex.quote(str(lib))
                        + '\nexec ' + shlex.quote(str(lib / 'rustlib/aarch64-apple-darwin/bin/rust-lld'))
                        + ' ' + extra + '"$@"\n')
    result['xcode-select'] = ('#!/bin/sh\nif [ "$1" = "-p" ]; then printf "%s\\n" '
                              + str(XCODE) + '; else exec /usr/bin/xcode-select "$@"; fi\n')
    return result


def missing_targets(lib):
    components = set((lib / 'rustlib/components').read_text().splitlines())
    return [target for target in TARGETS if 'rust-std-' + target not in components
            or not any((lib / 'rustlib' / target / 'lib').glob('libstd-*.rlib'))]


def wrapper_changes(lib):
    for parent in [OUT, *OUT.parents]:
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError(f'Wrapper directory is redirected or not a directory: {parent}')
    changes = []
    for name, expected in wrappers(lib).items():
        path = OUT / name
        if not path.exists() and not path.is_symlink():
            changes.append((path, expected))
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4096:
            raise ValueError(f'Preserving nonordinary wrapper: {path}')
        actual = path.read_text()
        equivalent = actual == expected
        if not equivalent:
            # Recognize only the exact old probe-generated template, including
            # its quoted paths. Equivalent ../ spellings need no rewrite.
            lines = actual.splitlines()
            parts = shlex.split(lines[1]) if len(lines) == 3 else []
            prefix = 'DYLD_LIBRARY_PATH='
            if name == 'xcode-select' or len(parts) != 2 or parts[0] != 'export' or not parts[1].startswith(prefix):
                raise ValueError(f'Preserving unknown wrapper: {path}')
            previous = Path(parts[1][len(prefix):])
            if not previous.is_absolute() or actual != wrappers(previous)[name]:
                raise ValueError(f'Preserving unknown wrapper: {path}')
            equivalent = previous.resolve() == lib
        if not equivalent or info.st_mode & 0o111 != 0o111:
            changes.append((path, expected))
    return changes


def prepare(check_only=False, install_targets=False):
    supplied = Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT', str(REPO / '../ALMA/.build/tauri-toolchain'))).expanduser()
    if not supplied.is_absolute():
        raise ValueError('ALMA_RUST_TOOLCHAIN_ROOT must be absolute')
    root = supplied.resolve(strict=True)
    lib = root / 'rustup/toolchains' / TOOLCHAIN / 'lib'
    executables = [root / 'cargo/bin' / name for name in ('rustup', 'cargo', 'rustc')]
    executables += [lib.parent / 'bin' / name for name in ('cargo', 'rustc')]
    executables += [lib / 'rustlib/aarch64-apple-darwin/bin/rust-lld', XCODE / 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang']
    for path in executables:
        if not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError(f'Missing executable; toolchain installation is manual: {path}')
    if not (lib / 'libLLVM.dylib').is_file():
        raise ValueError(f'Missing Rust LLVM runtime: {lib / "libLLVM.dylib"}')
    changes = wrapper_changes(lib)  # Refuse unknown wrappers before any mutation.
    missing = missing_targets(lib)
    if check_only and (missing or changes):
        raise ValueError(f'Unprepared inputs: targets={missing}, wrappers={[p.name for p, _ in changes]}')
    if missing:
        if not install_targets:
            raise ValueError(f'Missing targets: {missing}; explicitly opt in with --install-targets')
        env = dict(os.environ, CARGO_HOME=str(root / 'cargo'), RUSTUP_HOME=str(root / 'rustup'),
                   RUSTUP_TOOLCHAIN=TOOLCHAIN, RUSTUP_AUTO_INSTALL='0')
        subprocess.run([str(root / 'cargo/bin/rustup'), 'target', 'add', '--toolchain', TOOLCHAIN, *missing],
                       env=env, check=True, timeout=600)
        if missing_targets(lib):
            raise ValueError('Cross-target installation is incomplete; wrappers were not changed')
    if changes:
        OUT.mkdir(parents=True, exist_ok=True)
        for path, content in changes:
            with path.open('w' if path.exists() else 'x') as stream:
                stream.write(content)
            path.chmod(0o755)
    return {'verified': True, 'checkOnly': check_only, 'toolchainRoot': str(root),
            'targets': list(TARGETS), 'installedTargets': missing,
            'wrappersWritten': [p.name for p, _ in changes]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--install-targets', action='store_true')
    args = parser.parse_args()
    if args.check_only and args.install_targets:
        parser.error('--check-only cannot be combined with --install-targets')
    try:
        print(json.dumps(prepare(args.check_only, args.install_targets), indent=2))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'iOS build inputs: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
