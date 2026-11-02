#!/bin/bash
# Main-owned explicit app build. No Rust build, codegen, installation, or launch.
set -euo pipefail
probe_dir="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-}"
if [[ "$mode" != shell && "$mode" != bound ]]; then
    echo "Usage: bash build.sh shell|bound [prepare.py arguments]"
    exit 2
fi
shift
python3 "$probe_dir/prepare.py" --mode "$mode" --require-link-inputs "$@"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcodebuild -project "$probe_dir/.build/$mode/AlmaLocalAgentProbe.xcodeproj" \
    -scheme AlmaLocalAgentProbe -configuration Release \
    -destination 'generic/platform=iOS' -jobs 2 \
    -derivedDataPath "$probe_dir/.build/$mode/DerivedData" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO DEBUG_INFORMATION_FORMAT=dwarf build
