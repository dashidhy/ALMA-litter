#!/bin/bash
set -euo pipefail
probe_dir="$(cd "$(dirname "$0")" && pwd)"
lab_dir="$(cd "$probe_dir/.." && pwd)"
python3 "$lab_dir/prepare_owned_ish.py"
python3 "$probe_dir/prepare_payload.py"
bash "$lab_dir/cargo_ios.sh" rustc --locked --offline -p alma-backend-probe \
  --target aarch64-apple-ios --profile ios-dev --crate-type staticlib -j 2
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodegen generate --spec "$probe_dir/project.yml"
xcodebuild -project "$probe_dir/AlmaBackendProbe.xcodeproj" -scheme AlmaBackendProbe \
  -configuration Release -destination 'generic/platform=iOS' -jobs 2 \
  -derivedDataPath "$probe_dir/.cache/DerivedData" -allowProvisioningUpdates build
