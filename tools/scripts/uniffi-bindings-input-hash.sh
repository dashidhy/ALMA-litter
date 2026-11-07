#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUST_BRIDGE_DIR="$REPO_DIR/shared/rust-bridge"
CODEX_FORK_DIR="$REPO_DIR/../ALMA-codex"
KIMI_FORK_DIR="$REPO_DIR/../ALMA-kimi-code"
ZCODE_FORK_DIR="$REPO_DIR/../ALMA-ZCode"

bindings_inputs() {
  {
    printf '%s\n' \
      "$SCRIPT_DIR/uniffi-bindings-input-hash.sh" \
      "$RUST_BRIDGE_DIR/Cargo.toml" \
      "$RUST_BRIDGE_DIR/Cargo.lock" \
      "$RUST_BRIDGE_DIR/codex-mobile-client/Cargo.toml" \
      "$CODEX_FORK_DIR/codex-rs/Cargo.toml" \
      "$CODEX_FORK_DIR/codex-rs/app-server-protocol/Cargo.toml" \
      "$CODEX_FORK_DIR/codex-rs/protocol/Cargo.toml" \
      "$CODEX_FORK_DIR/ios/Cargo.toml" \
      "$CODEX_FORK_DIR/ios/native/Cargo.toml" \
      "$KIMI_FORK_DIR/ios/native/Cargo.toml" \
      "$ZCODE_FORK_DIR/ios/native/Cargo.toml"
    # The facade path-includes the fork modules. Include embedded assets too.
    find "$RUST_BRIDGE_DIR/codex-mobile-client/src" \
         "$CODEX_FORK_DIR/codex-rs/app-server-protocol/src" \
         "$CODEX_FORK_DIR/codex-rs/protocol/src" \
         "$CODEX_FORK_DIR/ios/native/src" \
         "$KIMI_FORK_DIR/ios/native/src" \
         "$ZCODE_FORK_DIR/ios/native/src" -type f
  } | LC_ALL=C sort -u
}

# Propagate discovery failures in both modes, including --newer-than.
BINDINGS_INPUTS="$(bindings_inputs)"

if [ "${1:-}" = "--newer-than" ]; then
  stamp="${2:?usage: $(basename "$0") [--newer-than STAMP]}"
  while IFS= read -r file; do
    if [ -f "$file" ] && { [ ! -e "$stamp" ] || [ "$file" -nt "$stamp" ]; }; then
      exit 0
    fi
  done <<< "$BINDINGS_INPUTS"
  exit 1
fi

{
printf 'LITTER_ALMA_LOCAL=%s\n' "${LITTER_ALMA_LOCAL:-0}"
while IFS= read -r file; do
  [ -f "$file" ] || continue
  shasum -a 256 "$file"
done <<< "$BINDINGS_INPUTS"
} | shasum -a 256 | awk '{print $1}'
