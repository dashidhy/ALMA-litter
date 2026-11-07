# Owned Kimi failure and verified compatibility fix

The Mac probe reproduces the phone failure using a byte-verified snapshot of `.build/vendor/litter-ish-owned`, its real Rust host crate, `boot_workspace_policy_with_workspace`, `prepare_workspace_grant`, and `spawn_with_grant`. Rust dependencies resolve in private offline lockfiles. Every generated file is inside this probe. The phone remains under the parent's control.

## Confirmed first failure

The original packaged guest fails after 24.8 seconds with `RangeError` and message `Internal error. Icu error.`. It has no Node error code. The stack is `String.localeCompare` → `InMemorySkillCatalog.listSkills` → `sdk/index.mjs:117090:62`. It makes zero HTTP requests and exits 1 with owned closure.

The ICU data file `/usr/share/icu/74.2/icudt74l.dat` reads successfully at 2,799,392 bytes. Temporary logging in the isolated kernel snapshot captured its mapping request with `flags=1` (`MAP_SHARED`), offset 0, 684 pages, and internal protection 129 (`P_READ | P_SHARED`). The existing `kernel/workspace_fd.c::wp_mmap` returns `ENOTSUP` for this file-backed shared map. The original source was restored byte-for-byte before final verification.

Production `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`, locale `C`, explicit English collation, and an explicit `ICU_DATA` path all reproduce the ICU error.

Evidence is retained in `.cache/production.stderr`, `.cache/diagnostic-mmap.stderr`, `.cache/diagnostic-icu.stdout`, and `.cache/diagnostic-c-locale.stdout`.

## Tested packaging fix

`build_icu_data.py` embeds the existing pinned `.dat` bytes in an ARM64 ELF shared object with exported, 16-byte-aligned `icudt74_dat` and SONAME `libicudata.so.74`. Replace the stub `usr/lib/libicudata.so.74.2` in a newly packaged rootfs with this data library. The dynamic loader uses private mappings. The successful probe uses the production environment and exact original policy.

Input SHA-256 is `ec1035db29767d51df2161dc8dcdb1700140a56e0cc70262444f20c89bed081d`.

Output SHA-256 is `c0c1dc1c77a7b1b8959ad061740f0183f8911918d7ded05217ea25b708286d76`.

The output is `.cache/libicudata.so.74.2`. `icu-embedding.json` records provenance. Production integration needs an explicitly versioned packaging transformation, updated resource hashes, and a new rootfs ID so installed devices adopt the corrected data library.

## Confirmed second failure

After the ICU fix, native `fs.promises.realpath` fails on the allowed scratch directory `home/empty-skills`. The SDK stack includes `sdk/index.mjs:115445`, `configuredRoots`, and `ExplicitFileSkillSource.load`.

The focused trace shows native resolution calling `readlink("/workspace")`. `generic_readlinkat` requires `WP_READ`, while `/workspace` has traversal rights. The log is `.cache/diagnostic-readlink-embedded.stderr`. Node's JavaScript `fs.realpathSync` succeeds. The tested asynchronous compatibility adapter uses Node's callback resolver.

```js
const fs = createRequire(import.meta.url)('node:fs');
const { promisify } = createRequire(import.meta.url)('node:util');
fs.promises.realpath = promisify(fs.realpath);
syncBuiltinESMExports();
```

Install this before SDK import. The complete successful test patched only the private generated guest. Its entry already imports `createRequire` and `syncBuiltinESMExports`. This preserves kernel checks on each path operation and requires no additional filesystem grants.

## Complete synthetic Raw Guardian result

With both compatibility fixes, the original kernel and production grants pass an entire minimal frozen Raw Guardian attempt. The host provides a synthetic SSE completion through the real guest pipe protocol.

- One HTTP request and acknowledgment
- Final text `{"safe":true}`
- Terminal `end_turn`
- Guest exit code 0 and signal 0
- Owned session closed with no supervisor failure
- Private home removed
- Guest elapsed time 35.3 seconds
- Peak sampled process RSS 699,808 KiB

The host has a 100-second guest deadline, a 115-second process deadline, and a 1,800 MiB sampled per-process RSS kill threshold. Builds use one Cargo job and a 600-second deadline. No API credential is used.

The final structured result is `.cache/embedded-realpath-success.json`. The stdout protocol transcript and stderr metadata have the same basename. `source-sha256.json` records the source snapshot. At final verification every original source file except the private generated Cargo lock matched its recorded hash.

## Reproduce

Run from this directory.

```sh
python3 run.py build
python3 run.py production
python3 build_icu_data.py
python3 run.py diagnostic-embedded
python3 run.py embedded-realpath-success
```

`run.py` freezes the initial packaging inputs in `.cache/packaging-inputs.json`. All source snapshots, build outputs, rootfs copies, workspaces, fixtures, and logs are local to this probe.

Production packaging changes, guest-entry integration, phone installation, and phone end-to-end verification belong to the parent. This probe verifies the full synthetic guest protocol and cleanup. The additional file-tool qualification below covers Read, Glob, Grep, Write, and Edit. Live-provider phone behavior remains for the integration lane.

## Kernel correction assessment

The ICU failure is an intentional `wp_mmap` policy rejection. The existing rule explicitly rejects file-backed shared mappings, including initially read-only mappings that could later become writable.

A faithful kernel fix would preserve `MAP_SHARED`, store the maximum writable permission derived from descriptor access and grant rights, enforce that permission during `mprotect`, preserve it across fork/remap, and avoid partial page-permission updates when protection changes fail. Current `pt_set_flags` assigns guest flags before host `mprotect` succeeds, and its mapping metadata carries no maximum-write permission. Simply removing the shared-map rejection needs broader correctness work.

An alternative scoped compatibility rule could convert read-only shared mappings on read-only granted descriptors into `MAP_PRIVATE`, clearing `P_SHARED` so fork uses COW. This deliberately changes the requested shared-mapping behavior. It would require explicit regression tests for later `mprotect` writes, fork visibility, partial pages, and backing-file immutability. That variant was assessed from source and was not implemented or qualified here.

The recommended current integration is the tested data-library packaging transformation plus the callback-based realpath adapter. Shared-library data packaging is an official ICU mode documented at https://unicode-org.github.io/icu/userguide/icu_data/ and https://unicode-org.github.io/icu/userguide/icu4c/packaging.html . The generated ELF wrapper is local build output around unchanged pinned ICU data.

## Reproducibility and ABI evidence

The exact compiler and linker commands used by `build_icu_data.py` are below. `$PROBE` means this directory and `$REPO` means its repository root.

```sh
/usr/bin/clang --target=aarch64-linux-musl -c "$PROBE/.cache/icu-data.S" -o "$PROBE/.cache/icu-data.o"
"$REPO/tools/alma-ios-lab/.cache/phone-build-bin/ld.lld" -shared --soname=libicudata.so.74 --hash-style=both "$PROBE/.cache/icu-data.o" -o "$PROBE/.cache/libicudata.so.74.2"
python3 "$PROBE/verify_icu_elf.py"
```

The assembly uses `.incbin` for the pinned archive, `.balign 16`, and a global object symbol named `icudt74_dat` in `.rodata`. The builder asserts the input SHA before compilation.

- Apple clang 21.0.0, build `clang-2100.4.1.1`
- LLD 23.1.1, Rust LLVM revision `1b9c0d5ff9bbe7634aead059efe6b11a7eeba145`
- Original stub library SHA-256 `a8a959195940f14fccfa7ad7eaab9c5d19fc30c3797d78e541757cafc3050748`
- Original and replacement SONAME `libicudata.so.74`
- Original and replacement sole export `icudt74_dat`, GLOBAL OBJECT, default visibility
- Original stub symbol size 64 bytes, replacement symbol size 2,799,392 bytes
- ARM64 ELF64 little-endian shared library, with no executable LOAD segment
- Existing `libicuuc.so.74.2` imports exactly that symbol and SONAME
- Extracted replacement symbol bytes match the original `.dat` byte-for-byte
- A second build reproduces SHA-256 `c0c1dc1c77a7b1b8959ad061740f0183f8911918d7ded05217ea25b708286d76`

Full machine-readable ELF, consumer, and tool-version evidence is `.cache/icu-elf-verification.json`.

The native workspace mount rejects a pre-existing symlink with `ENOTSUP`. The callback resolver succeeds on the allowed scratch directory and returns `EACCES` for a direct path outside the grants. Creating a guest symlink is also denied. These controls are recorded in `.cache/diagnostic-compat-embedded.stdout`.

## Integrated production resources and actual file tools

The extended probe selected the exact resources from the parent's generated Tauri project and froze them in `.cache/integrated-inputs.json`.

- Rootfs lock `121f61e704e53396f429cbb57db2d9b3b06818eaa3d8bd3fce63f89ea5e96ea7`
- Runtime package `aace22419d604cb313d36d8115c1ad96d71707edb83a13429db9ee8335f013f6`
- The copied guest entry is byte-identical to that production resource
- The original owned host source and grants are used, with Actor write access restricted to `view/outbox` and scope scratch

Raw Guardian passed Read → Glob → Grep using a frozen UTF-8 material with Chinese text and emoji. The synthetic model received the actual Read text, actual matching filename, and actual Grep match in subsequent requests. All three normalized tools completed successfully. The run made four HTTP exchanges and emitted 13 contiguous events, then returned `end_turn`, exited 0, and acknowledged owned closure in 38.6 seconds. Peak sampled process RSS was 746,432 KiB.

Actor passed Read → Glob → Grep → Write → Read → Edit → Read. The probe verified the written content in a subsequent model request, applied a replacement, verified the edited content in another request, and compared the host-side output file to the expected UTF-8 bytes. All seven tools completed successfully. The run made eight HTTP exchanges and emitted 25 contiguous events, then returned `end_turn`, exited 0, and acknowledged owned closure in 39.4 seconds. Peak sampled process RSS was 738,800 KiB.

Both cases preserved the frozen input, removed the private home, acknowledged every response chunk, and produced a final message matching the terminal text. All validation assertions passed. No API credential is used. Processes retained the existing 100-second guest deadline, 115-second process deadline, and 1,800 MiB sampled RSS limit.

```sh
python3 run.py build
python3 run.py tools-guardian-success
python3 run.py tools-actor-success
```

Structured assertions are `.cache/tools-guardian-success-validation.json` and `.cache/tools-actor-success-validation.json`. Process metadata, frozen start fixtures, scripted tool plans, and transcripts use the same mode prefixes. Live-provider phone validation belongs to the parent's integration run.
