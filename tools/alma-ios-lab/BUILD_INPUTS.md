# iOS build inputs

Run from the repository root on an Apple Silicon Mac with full Xcode at
`/Applications/Xcode.app`, Python 3.11+, uv, Ninja, curl and xcodegen available.
These commands prepare inputs; the explicitly labelled host-build step below
is needed to assemble the rootfs. None installs or runs a phone app.

Use an existing Rustup installation with the layout `cargo/bin` and
`rustup/toolchains/stable-aarch64-apple-darwin` beneath one directory:

```sh
export ALMA_RUST_TOOLCHAIN_ROOT=/absolute/path/to/tauri-toolchain
```

The existing development default is `../ALMA/.build/tauri-toolchain`; the sibling
repository is not required when this variable points to an equivalent toolchain.
The helper validates Rust/Cargo/Rustup, Rust's linker and LLVM library, Xcode
clang, and the iOS and Linux-musl standard libraries. It does not install or
update the host toolchain or global tools.

## 1. Pinned Codex source and local wrappers

```sh
git submodule update --init shared/third_party/codex
python3 tools/alma-ios-lab/prepare_codex.py
python3 tools/alma-ios-lab/prepare_ios_build.py
python3 tools/alma-ios-lab/prepare_ios_build.py --check-only
```

The gitlink must be the public Codex 0.166 base
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. The parent repository carries its
patch stack; do not create a submodule commit. `prepare_codex.py` refuses
unrecognized edits. Its `--check-only` preserves source but writes scratch/report
files; it is not a fully read-only check.

`prepare_ios_build.py` writes only missing or recognized wrappers under
`tools/alma-ios-lab/.cache/phone-build-bin`. Unknown files are preserved and
rejected. Its `--check-only` performs no writes, subprocesses or downloads.
Missing cross-targets fail by default. To explicitly allow only their Rustup
downloads, run:

```sh
python3 tools/alma-ios-lab/prepare_ios_build.py --install-targets
```

## 2. Pinned iSH, APKs and V8

The following commands explicitly allow missing input downloads. Existing
archives/assets are hash-checked; large cache/vendor outputs remain uncommitted.

```sh
python3 tools/alma-ios-lab/prepare_ish_host.py --fetch --prepare-only
python3 tools/alma-ios-lab/prepare_owned_ish.py
python3 tools/alma-ios-lab/prepare_ish_packages.py
python3 tools/alma-ios-lab/prepare_native_v8.py
python3 tools/alma-ios-lab/prepare_native_v8.py --check-only
```

The iSH preparer fetches the pinned source/base-rootfs archives and prepares local
Meson. `prepare_owned_ish.py` applies the six reviewed patches to
`.build/vendor/litter-ish-owned`; Cargo requires that path even on a fresh checkout.
The APK helper restores the 30 packages from `results/2026-10-31-ish-package-lock.json`.
V8 preparation supplies `.build/vendor/codex-v8` plus the pinned iOS archive and
bindings. Plain V8 remains the documented JIT-disabled qualification variant.

## 3. Rootfs assembly (explicit local host build)

```sh
python3 tools/alma-ios-lab/prepare_ish_host.py
python3 tools/alma-ios-lab/prepare_runtime_rootfs.py
```

The first command builds the host iSH CLI and checks its VDSO. The second runs
that guest to install the locked APKs and verify Bash/Python/Node. It produces
`.cache/runtime-rootfs/354d49ec25295e6c/fs`, the path consumed by the app packaging
scripts; reuse checks its recorded tree digest. Do not commit this generated fs.

## 4. Cargo cache and app packaging

After both path overrides exist, an empty Cargo cache needs an explicit fetch:

```sh
bash tools/alma-ios-lab/cargo_ios.sh fetch --locked
bash tools/alma-ios-lab/cargo_ios.sh fetch --locked --manifest-path "$(pwd)/.build/vendor/litter-ish-owned/embed/Cargo.toml"
```

These commands can download dependencies; neither is run by the wrapper helper.
Then follow [the Tauri build recipe](../mobile-tah/README.md#tauri-build-and-reproduction)
for owned JS sources, npm locks, generated configuration, Rust archives and UniFFI
bindings. No private prebuilt archive, cached wrapper or device export needs to be
committed. Keep the parent Cargo lock, patch series, source/asset locks and the
preparation scripts together.
