# iPhone continued-processing probe

2026-11-01. Disposable bundle `com.alma.litter.background-probe`, iPhone 12 Pro,
iOS 27.0.1, Release without a debugger. The Mac remains connected by cable;
Low Power Mode was off. The test app was removed after results were collected.

This runs the pinned iSH interpreter/supervisor with actual Node/Python text
processing and native HTTPS. It **does not run Codex, call a model, or validate
TAH**. It repeatedly processes the existing NVIDIA fixture (254 turns / 117155
UTF-8 bytes). A 29-minute endurance run is not one article's Agent latency.

## Results

[Machine-readable summary](../results/2026-11-01-background-probe.json) links by
run ID to the raw `results/background/<run>/` reports and controller receipts.

- Continuous Node/text + HTTPS completed all **90 cycles and 18 HTTPS requests**
  in **1726.29 seconds**. Peak sampled App footprint was **44.00 MiB**; thermal
  state remained nominal. This proves sustained background work for this case.
- A Node control with a 120-second quiet wait received expiration **31.13 seconds
  after its last completed text operation**, with almost no CPU consumed during
  the wait. A preceding 45-second wait was tolerated. This is not a universal
  hard-coded 30-second runtime limit.
- Indeterminate Foundation progress did not solve the gap: on that run, expiry
  occurred shortly after entering background. No synthetic progress increments
  were used during any wait.
- Mixed Python+Node processing took roughly 5 wall/CPU seconds in foreground and
  roughly 41 wall / 40 CPU seconds in a measured background cycle. It is not
  simply 35 seconds spent awaiting scheduling. Attribution to hardware cores,
  frequency, or interpreter behavior still needs profiling.
- An early `example.com` HTTPS attempt failed TLS while still foregrounded; it
  is a network control failure, not evidence of a background failure. Build6
  uses Apple's public success page without disabling certificate validation.
- HID lock commands returned success, but `devicectl` still reported no passcode
  required and a later screenshot showed Home. **Actual locked-device execution
  is not established.** It needs separately confirmed physical locking.

## Runtime behavior and limits

`BGContinuedProcessingTask` is registered with default CPU/network resources.
The iOS27 asynchronous submission API is used. A native callback launches the
Rust/iSH worker after the system invokes the handler; handlers, submit acceptance,
app lifecycle, real completed units, CPU time, and expiration are recorded.
Native HTTPS sends no transcript. Progress advances only for completed setup,
text processing, or successful network work. Liveness measurements never advance
the task's progress. The indeterminate experiment changes progress representation
without increasing completed counts.

Limits: 35-minute wall guard, 900MiB footprint, 180MiB available-memory floor,
8GiB starting free-space floor, 16MiB stderr limit, serious thermal-state stop,
90-second guest command deadline, and bounded native HTTPS. These are probe
limits, not product policy. Expiration requests stop, then the test host exits;
this is not the production cancellation/process-tree implementation.

After normal completion, the system may suspend the App before its delayed
self-exit. The collector confirmed the exact App PID, explicitly stopped it,
then uninstalled this bundle. See the successful run's `cleanup.json`; do not
describe this as a proven self-exit path. Alma Preview was not modified.

## Reproduce

Use the existing fixed source/APK preparation under the parent lab. A private
fixture is read from the ignored `.cache/fixtures/nvidia-source.json`.

```sh
bash tools/alma-ios-lab/background_probe/build.sh
xcrun devicectl device install app --device <device-id> <built-app-path>
python3 tools/alma-ios-lab/background_probe/phone.py start --device DEVICE_ID --mode continuous --cycles 90 --workload node
# Background/lock through the device UI, then collect explicitly.
python3 tools/alma-ios-lab/background_probe/phone.py sample --device DEVICE_ID
python3 tools/alma-ios-lab/background_probe/phone.py collect --device DEVICE_ID
```

`quiet` adds15/45/120-second gaps. `quiet-indeterminate` represents those gaps
with an unknown duration. `mixed` workload runs Python then Node; `node` performs
independent JSON/hash/write/rename/readback checks. Never install/restart over an
active endurance run. `phone.py` does not continuously poll or attach a debugger;
The historical `home`/`lock` actions now fail before touching a device because
their shared-RSD HID route could disrupt developer connections. Use the device
UI and verify the actual foreground/lock state; old HID receipts are historical
evidence, not proof that locking succeeded. Product initiation must come from a user action;
the probe also supports an explicitly requested test launch argument.

Build1 did not enter the probe because its UIKit lifecycle configuration was
incomplete; switching to the same scene lifecycle as the established iSH probe
fixed it. A host build setup failure also came from leaking the iOS deployment
target into the Mac compiler; preparation now separates those lanes. Neither
is counted as an iSH or BGTask compatibility failure.

Current H2 status: continuous background work demonstrated; long silent waits
fail in tested cases; strict lock and real Codex/provider-event behavior remain
unverified. No production acceptance claim.
