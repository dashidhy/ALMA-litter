# Independent plain iOS V8 probe

This is a separate App with **no account, recording data, model requests or
Code Mode provider**. It checks a pinned native V8 engine using fixed scripts.
It does not change the credentialed ALMA test App's memory boundary.

Inputs are locked in `source-lock.json`: Codex 0.166's exact rusty_v8 fork
revision, the published plain iOS 152.2.0 archive, and its matching bindings.
The source archive contains about 2 MB and does not fetch V8 submodules. The
binary download is 20,105,761 bytes. `build.py` forces prebuilt inputs, checks
digests/source, uses two Cargo jobs, and never enables a V8 source build.

## Results on iPhone 12 Pro / iOS 27.0.1

- Build 1, no extended-address entitlement: V8 initialization aborted with
  `Oilpan: CagedHeap reservation`. No JS case ran. The sampled footprint before
  the abort was about 10.8 MiB; this is an address-reservation failure, not proof
  of physical-RAM exhaustion. Run `7e366445-83fc-483a-b43e-6d6f86c60583`.
- Build 2, **Extended Virtual Addressing**: six checks passed. V8 initialization
  plus five tiny scripts took 29.52 ms inside Rust; the UI harness reported
  72.13 ms. Sampled App footprint peaked at 18.77 MiB. This includes the small
  native UI, not the complete Codex App. Run `38ecb3b4-9cc7-41d1-8208-9398c430f370`.
- Build 3 retained the six passes and surveyed extra `PROT_NONE` reservations.
  Both 1 TiB and 2 TiB returned `ENOMEM`. No reserved pages were touched. This
  does not by itself prove whether V8's partial-reservation paths can work.
  Run `d470d475-b5e0-45d1-9304-5d43ed081246`.

All three processes were confirmed ended. Cases cover arithmetic, UTF-8/JSON,
fresh contexts, and unavailable WebAssembly. They do not cover Code Mode's
delegates, store/commit semantics, cancellation, or complete ABI conformance.

Only `com.apple.developer.kernel.extended-virtual-addressing` is enabled in
builds 2–3. **Increased Memory Limit is not enabled.** Apple's documentation
describes the former as allowing a larger addressable space:
[Extended Virtual Addressing](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.extended-virtual-addressing).

The plain artifact does **not** supply Codex's requested sandbox/pointer-compression
configuration. Upstream Code Mode has a test asserting sandbox-enabled V8; this
probe is not acceptance of that invariant or permission to advertise security
equivalence. See `../results/code-mode-v8-ios-feasibility.json`.

## Reproduce

From the repository root, with the existing Rust/Xcode toolchain:

```sh
python3 tools/alma-ios-lab/v8_plain_probe/build.py
tools/alma-ios-lab/.cache/device-tools/bin/pymobiledevice3 apps install \
  --udid DEVICE_ID --developer --streaming \
  tools/alma-ios-lab/v8_plain_probe/.cache/DerivedData/Build/Products/Release-iphoneos/AlmaV8Probe.app
python3 tools/alma-ios-lab/v8_plain_probe/run_phone.py --udid DEVICE_ID
```

Use `--refresh-lock` only for an intentional probe manifest/lock update. The
runner launches only this bundle, collects its own reports, and checks its PID;
it does not sign in, run models, alter device settings, or save unrelated process
inventories. The UIKit harness retains its memory, thermal, disk and time guards.
