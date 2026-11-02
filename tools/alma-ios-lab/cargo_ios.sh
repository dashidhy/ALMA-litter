#!/bin/bash
set -euo pipefail
lab_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$lab_dir/../.." && pwd)"
export ALMA_RUST_TOOLCHAIN_ROOT="${ALMA_RUST_TOOLCHAIN_ROOT:-$repo_dir/../ALMA/.build/tauri-toolchain}"
export CARGO_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/cargo"
export RUSTUP_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/rustup"
export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
export CARGO_TARGET_DIR="$repo_dir/shared/rust-bridge/target"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export LIBCLANG_PATH="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib"
export CARGO_NET_GIT_FETCH_WITH_CLI=true
# This qualification lane is entirely local; do not use upstream remote build caches.
export RUSTC_WRAPPER=
export SCCACHE_DISABLE=1
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
export GIT_CONFIG_VALUE_0=ssh://git@github.com/
export GIT_CONFIG_KEY_1=http.version
export GIT_CONFIG_VALUE_1=HTTP/1.1
export PATH="$lab_dir/.cache/phone-build-bin:$lab_dir/.cache/ish-tools/bin:$CARGO_HOME/bin:$PATH"
cd "$repo_dir/shared/rust-bridge"
exec cargo "$@"
