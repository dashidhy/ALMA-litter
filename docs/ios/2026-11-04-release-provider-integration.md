# Release-fork provider integration

2026-11-04 · ALMA TAH 0.3.6 (12) · iPhone 12 Pro · iOS 27.0.1.

## Accepted release sources

| Provider | Official tag | Base commit |
| --- | --- | --- |
| Codex | `rust-v0.166.0` | `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` |
| Kimi Code | `@moonshot-ai/kimi-code@2.4.1` | `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` |

Both official annotated tags were fetched and checked against their commits.
Each fork's `dev/ios` migration commit starts directly from its release base.
The pre-migration heads are retained in `codex/pre-ios-migration-20261104`.
Official HTTPS remotes are named `upstream`.

The local migration commits are `9e63525810467eb86960f152d6794d50872460be`
in ALMA-codex and `34d523c1289d191eb52962a57b87ac94cd95dc86` in
ALMA-kimi-code. Each parent equals the official release commit listed above.
Both fork worktrees are clean. The application composition and this report
remain in the ALMA-litter working tree.

Kimi 2.5.0 was reviewed and deferred by the user. Reassess the next official
release after 2.5.0. The current qualification uses SDK 0.22.0.

## Source ownership

The application owns TAH scheduling, Guardians, revisions, publication,
credentials, persistence and presentation. Provider adapters are loaded from
the forks. The native facade compiles fork-owned modules through explicit Rust
source paths and preserves the original single UniFFI namespace.

`extern crate self as alma_codex_ios` makes Kimi's shared-host imports resolve
to those exact compiled scope and filesystem definitions. The same auth
dispatcher serves Swift callback registration and Codex refresh requests.
The local-only bootstrap precondition remains at the application boundary.

`ALMA-codex/ios/native` owns Codex transport and the shared sealed execution
host. `ALMA-kimi-code/ios/native` owns Kimi transport and resource installation.
The Rust workspace resolves official Codex sources and iSH/V8 inputs through
the Codex fork. The binding cache includes both forks and their protocol inputs.

## Equivalence checks

- All 33 adapted upstream Codex paths match the qualified source.
- Native module bodies match after the documented visibility/import adjustments.
- All four regenerated Swift/header/module-map files are byte-identical to the
  previous app's bindings.
- All 744 Kimi SDK files and the 808,109-byte guest bundle are byte-identical
  to the qualified artifacts.
- The old installed trusted-JS bundle retained an unused Write-only
  `approveKimiTool` predicate. Its sole difference in the current build is the
  existing five-tool missing-path fix. Trusted host code calls `kimiProfile`.
  The actual guest approval handler already used the fixed predicate and is
  byte-identical. Current-source builds before and after relocation are identical.
- Kimi profile identity and SDK provenance metadata reflect the relocated sources.

The signed executable SHA-256 is
`67be3ef934dd874bbcbef919ce14880bb7dd81902230dc10294c18f33109d1d4`.
Its Mach-O UUID is `B71187AC-475B-3A1A-B14A-F65F947A8EDE`.
The native archive SHA-256 is
`200a9d9118d1ae1a0fa5a0c2580ef2a637fe0f776d0b7ae007a091300eb3c2c5`.
Both source-identity records are included in the signed app bundle.

## Phone acceptance

Each provider ran a fresh NVIDIA V0 followed by the same title-only V1 request.
Interaction and notes languages were Simplified Chinese, with Web enabled.
The exact pasted instruction was checked in the authoritative operation journal.

| Provider/model | Effort | V0 | V1 |
| --- | --- | --- | --- |
| Codex / GPT-6-Astra | xhigh | 851.734 s · PASS | 66.475 s · PASS |
| Kimi Code / K3.1 Pro | max | 1289.163 s · PASS | 156.386 s · PASS |

Raw Guardian and Extra Guardian completed successfully. All four Rule Critic
results passed. Eight published files passed length, SHA-256 and UTF-8 checks.
Both revisions changed the requested title while preserving the remaining
note body and ASR index byte for byte. Ordinary nonzero tool results were
retained and the agents continued to accepted publication.

The journal grew from 216 to 242 events. Every original row remains
byte-identical, integrity checks returned `ok`, and pending writes are zero.
All four Actor attempt directories were released. Kimi's final native receipt
sequence includes `end_turn`, close, capture and release, followed by account
inspection. A productive model stream of 328.517 seconds completed during V0.
The observed session-index mirror retry count was zero.

This is foreground functional acceptance. Background execution and power were
not remeasured. Artifact contracts and the V1 changes were checked. The notes
have not received an exhaustive factual audit.

Machine-readable evidence is in
[the phone result](../../tools/mobile-tah/results/2026-11-04-release-repo-phone.json).
Raw artifacts remain under the ignored
`tools/mobile-tah/.cache/release-repo-phone-2026-11-04` directory.

## Reproduction

Keep the two forks as siblings of this application checkout. Prepare their
locked native, SDK and rootfs inputs using their `ios/README.md` files.
`ALMA_IOS_BUILD_CACHE` can select an existing verified artifact cache.

```sh
python3 -B tools/mobile-tah/build_tauri.py
python3 tools/alma-ios-lab/prepare_bindings.py \
  --library shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a \
  --output-dir shared/rust-bridge/generated/swift-tauri \
  --report tools/mobile-tah/.cache/tauri-bindings.json
python3 -B tools/mobile-tah/prepare_tauri_app.py
xcodebuild -project tools/mobile-tah/.cache/tauri-app/AlmaTAHTauri.xcodeproj \
  -scheme AlmaTAHTauri -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath tools/mobile-tah/.cache/TauriDerivedData \
  -jobs 2 -allowProvisioningUpdates build
```

The archive dependency record contains both fork source paths. Binding
generation reads that exact archive. Packaging checks its identity and verifies
the Kimi runtime manifest.

## Supporting test correction

The integrated working-stream test asserted the final UI state before its
notification was delivered and required an intermediate state that could be
coalesced. Its correction uses bounded delivery gates and independently tests
the active state. Normal and 20 ms delayed-ACK variants passed 26/26 runs.
Suppressing terminal delivery failed at the expected 10-second bound. The
change is confined to test code and temporary harness copies.
