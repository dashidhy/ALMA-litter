#!/bin/bash
set -euo pipefail
probe_dir="$(cd "$(dirname "$0")" && pwd)"
ALMA_PROBE_RUST_ONLY=1 bash "$probe_dir/../ios_probe/build.sh"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate --spec "$probe_dir/project.yml"
xcodebuild -project "$probe_dir/AlmaBackgroundProbe.xcodeproj" -scheme AlmaBackgroundProbe \
  -configuration Release -destination 'generic/platform=iOS' -jobs 3 \
  -derivedDataPath "$probe_dir/.cache/DerivedData" -allowProvisioningUpdates build
