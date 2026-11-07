# Kimi mobile compatibility checks on Mac

This isolated research lane runs the **real Kimi SDK in the Linux ARM64 Node
guest under iSH's macOS C host**. The 2026-11-02 baseline uses synthetic text and
an in-memory model-response fixture. On 2026-11-03 the user authorized account
testing and alignment with the latest release. The current integration review
and real-request results are in [INTEGRATION_REVIEW.md](INTEGRATION_REVIEW.md).

## Latest release experiment, 2026-11-03

Kimi Code 2.4.1 / SDK 0.22.0 is pinned in `latest-source.lock.json`. Run
`python3 tools/kimi-mobile-probe/prepare_latest.py --verify-only` to verify the
cached 744-file SDK artifact. `--rebuild` performs the recorded source build.
The existing permission-rules patch applies unchanged and remains required.

Pass `--source-lock tools/kimi-mobile-probe/latest-source.lock.json` to `run.py`
with `--kimi-dir tools/kimi-mobile-probe/.cache/latest-release/artifact/opt/kimi`
to test that release. Offline fixture and cancellation modes retain their
synthetic response transport.

For an authorized live run, prepare `--mode live --prepare-only` with the same
arguments, then run `live-host.mjs <prepared-run-directory> <private-token-file>`
using the prepared native Node 24 toolchain. The guest uses a placeholder
credential handle. The native host injects the real header, validates destinations,
streams bounded chunks and joins outstanding request tasks before reporting.
`pipe-host.py` supplies POSIX pipes for the Mac iSH C host. The live test uses
the real Kimi provider codec and `kimi-for-coding / low`.

`node --test tools/kimi-mobile-probe/pipe-fetch.test.mjs` checks body destruction,
header-wait cancellation and chunk acknowledgements. Phone integration uses
Rust-owned execution and transport lifecycles, which need separate acceptance.

The following sections document the original 2.3.1 baseline.

## Fixed inputs

- Kimi Code 2.3.1 / SDK 0.21.1, upstream
  `684bae9ea6a437f3bae98bba1dcb797a917d500b`, with the existing Mac adapter's
  permission-rules patch. This is the tested Mac baseline, **not latest 2.4.1**.
- Exact compiled `sdk/index.mjs` SHA-256:
  `25b5db0e89c1c47655e08d72a344d6bebed77f9b07571a2e7ae317b341c748f4`.
  The source-reference build and Mac appliance's staged SDK match byte-for-byte.
- iSH upstream C host commit `4f783cd957b83de3019d6a843408d5bb3ff902c7`;
  binary hash is checked against the existing host-build provenance.
- Prepared rootfs `354d49ec25295e6c`, Node 22.23.4 / Linux ARM64 / musl.
  iSH injects `--jitless --no-lazy --max-old-space-size=512`;
  `WebAssembly` is unavailable.
- The host lane uses the same interpreter lineage, but **not** the current
  patched Rust supervisor, workspace grants or iOS application lifecycle.

Each run copies the clean rootfs and just the distributable SDK/dependency
closure into a new ignored directory. `inputs.json` records every dependency
file hash. Nothing loads a user's Kimi home, credentials or existing transcript.
The SDK is not rebuilt or patched by this probe.

## Compatibility finding and experimental adaptation

The original SDK module could finish importing, but session creation terminated
with `ReferenceError: WebAssembly is not defined` in Node's built-in Undici.
The initial import-only result is a module-load observation, not full runtime
readiness: an immediate process exit could mask pending asynchronous errors.
The current probe yields to the event loop before reporting success.

Minimal guest diagnostics narrowed the failure further: ESM `import('node:http')`
alone fails, while CommonJS `require('node:http')` and the tested imports of
HTTPS, streams, util and worker_threads complete. Node 22.23.4 exposes lazy
WebSocket/CloseEvent/MessageEvent exports on `http`; ESM export enumeration
loads Undici. See [the official implementation](https://github.com/nodejs/node/blob/v22.23.4/lib/http.js).
The general jitless/fetch limitation is also tracked in
[Undici #4708](https://github.com/nodejs/undici/issues/4708).

The optional probe-only adaptation:

1. Access `node:http` through CommonJS before ESM loading and replace the three
   unused WebSocket exports with explicit unsupported constructors.
2. **Delete** lazy global web bindings before replacing them. Simply redefining
   them was observed to evaluate the original lazy initializer and load Undici.
3. Use the already-cached, unmodified node-fetch 3.3.2 Headers/Request/Response/
   FormData implementations. Six pure-JS package versions and their bytes are
   recorded. No package installation or new runtime binary is needed.
4. Replace fetch with an in-memory streamed fixture. Unexpected fetch targets
   and socket connection attempts fail. This is a test guard, not an OS sandbox.

Earlier replacement experiments failed and remain in `.cache` reports. The
successful experiment does not enable JIT, implement WebAssembly, suppress its
errors, or modify Kimi's Agent Loop/tools. It also does not qualify real network
transport: no socket, TLS, credential broker or official Kimi service is tested.

## Assertions

`fixture` uses the real Harness, session, OpenAI-compatible provider codec,
SSE parser, Read/Write tools, approvals, persistence and terminal events. Model
responses are scripted; no model generates the fixture note.

- Effective tools are exactly Read/Write; the existing explicit ask rules apply.
- A real Read's unique source text must appear in the next model request.
- Both tool results must be successful and non-synthetic.
- Written Markdown, including Chinese and emoji, is checked byte-for-byte.
- Native completion and both `session.close()` / `harness.close()` must return.
- `cancel` aborts an outstanding synthetic model request and requires native
  `cancelled`, followed by the same close calls.

The host runner records guest and host exits separately and enforces a 180 s
wall limit, 1.5 GiB sampled host RSS guard, bounded logs and an 8 GiB disk reserve.
Guest `process.memoryUsage().rss` reports zero here and is **not usable**;
memory observations use sampled macOS host-process RSS. Neither that metric nor
host timing predicts iPhone footprint/latency. No power measurement is made.

Close API success plus the disposable host process exiting is not proof of
native scope isolation, natural event-loop quiescence, or background recovery.
Mac TAH integration, Kimi-specific provider codec, WebSearch/FetchURL, current
mobile backend integration, device lifecycle, and real-model quality remain
separate validation stages.

## Reproduce

Prepare the existing host lane and rootfs using
[`../alma-ios-lab/README.md`](../alma-ios-lab/README.md). Pass the prepared
appliance's `opt/kimi` directory (containing `sdk` and `node_modules`) and the
already-installed upstream `.pnpm` dependency store. The runner refuses a
different SDK hash and reused run names.

```sh
python3 tools/kimi-mobile-probe/run.py \
  --kimi-dir /absolute/path/to/prepared/opt/kimi \
  --dependency-store /absolute/path/to/upstream/node_modules/.pnpm \
  --mode fixture --run fixture-new

python3 tools/kimi-mobile-probe/run.py \
  --kimi-dir /absolute/path/to/prepared/opt/kimi \
  --dependency-store /absolute/path/to/upstream/node_modules/.pnpm \
  --mode cancel --run cancel-new
```

Omit `--dependency-store` to reproduce the unadapted Node-web-bindings path.
Results and input inventories are in `.cache/<run>/`; sanitized measurements
are in `results/2026-11-02-mac-compatibility.json`.
