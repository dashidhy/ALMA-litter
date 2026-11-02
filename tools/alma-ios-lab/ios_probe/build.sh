#!/bin/bash
set -euo pipefail
probe_dir="$(cd "$(dirname "$0")" && pwd)"
probe_repo="$(cd "$probe_dir/../../.." && pwd)"
cd "$probe_repo"
export ALMA_RUST_TOOLCHAIN_ROOT="${ALMA_RUST_TOOLCHAIN_ROOT:-$probe_repo/../ALMA/.build/tauri-toolchain}"
export CARGO_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/cargo"
export RUSTUP_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/rustup"
export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
probe_lab="$(cd "$probe_dir/.." && pwd)"
export CARGO_TARGET_DIR="$probe_dir/.cache/cargo"
export CARGO_BUILD_JOBS=3
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export IPHONEOS_DEPLOYMENT_TARGET=16.0
export LIBCLANG_PATH="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib"
export PATH="$probe_lab/.cache/phone-build-bin:$probe_lab/.cache/ish-tools/bin:$CARGO_HOME/bin:$PATH"
mkdir -p "$probe_dir/.cache"
python3 "$probe_dir/../prepare_ish_host.py" --prepare-only
python3 "$probe_dir/../prepare_ish_packages.py"
python3 "$probe_dir/../prepare_ios_build.py" --install-targets
cargo build --locked --manifest-path "$probe_dir/rust/Cargo.toml" --target aarch64-apple-ios --release
if [ ! -d "$probe_dir/.cache/payload" ]; then python3 "$probe_dir/prepare_payload.py"; fi
if [ "${ALMA_PROBE_RUST_ONLY:-0}" = 1 ]; then exit 0; fi
xcodegen generate --spec "$probe_dir/project.yml"
xcodebuild -project "$probe_dir/AlmaISHProbe.xcodeproj" -scheme AlmaISHProbe \
  -configuration Release -destination 'generic/platform=iOS' -jobs 3 \
  -derivedDataPath "$probe_dir/.cache/DerivedData" -allowProvisioningUpdates build
