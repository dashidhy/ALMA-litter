This is a host qualification controller and concrete USB phone port, not a shipping phone scheduler.
The six-attempt synthetic V0/V1/V2 flow passed on the iPhone on 2026-11-01;
see `../results/2026-11-01-tah-phone-qualification.json` for scope and timings.
`controller.ts` imports the ORIGINAL sibling ALMA TAH builders, coordinator,
Guardian parsers, event ledger and durable publisher. It loads the existing
synthetic fixture pack and verifies its source hashes. It contains no credential
access, device command, model client, replacement acceptance logic or automatic run.

`phone-port.ts` provides `PhonePort`; select a caller-owned journal root, then explicitly call
`runQualification(actorInference, phonePort, journalPort, abortSignal)`.
The default ports still throw; `file-journal.ts` now provides a concrete `JournalPort`.
The original coordinator creates each fresh attempt and
retains responsibility for V0/V1/V2 seeding, Guardian decisions, structural critic,
and publication. Pass `createFileJournal(absoluteRoot)` as `journalPort`; no
in-memory/fake-success journal is supplied. See the storage details below.

Draft outbound wire: `projectPhonePayload(built)` returns `attemptJSON`,
`attemptSHA256`, and `inputFiles[{relativePath,base64}]`. It validates with the
original FrozenAttempt parser, preserves the serialized attempt bytes, and checks
every input against original material/file-seed length and digest metadata.
Main owns writing `Documents/inbound-attempt.json` outside the model workspace and
the final wire schema. Never send the surrounding host request/binding to the model.

`PhonePort.runFresh` must perform exactly one fresh App process attempt and emit
real normalized events. `admitReaped` is a required trusted HOST verifier: compare
the launched PID/process identity, observe OS exit independently, verify actual
account fingerprint/model/attempt/scope binding, and quarantine exact candidate
bytes before returning. A phone JSON `exited:true` or `accepted:true` is insufficient.
The concrete USB implementation performs those gates. Errors lock this invocation;
there is no automatic uncertain-side-effect retry.

The nominal order is Raw, Actor0, Extra1, Actor1, Extra2, Actor2. The port allows
up to nine unique attempts so the original coordinator's one structural repair
per revision remains available. Role order and repair decisions stay in the
original coordinator. Host crash resume
and the App raw-receipt cache are not implemented; phone-process restart between
attempts is delegated to the port. The host process remains alive throughout.

Identity is `accountFingerprint = SHA256(actual phone OAuth accountID)`, never the
raw ID, email or tokens. `profileDigest` is the trusted host's frozen qualification
profile identity. Real catalog/efforts are parsed by the original catalog schema.
Fingerprint/profile/catalog must remain bound across the run and be rechecked in
each fresh process BEFORE model submission and in the admitted receipt. The port's
inspection cannot be satisfied by accountReady alone: the original App requires a
completed successful authorization inspection, including usable usage data.
See `phone-port-review.json` for the implemented gate; do not synthesize a successful
Mac AuthSnapshot from incomplete phone metadata.

Live entry (explicit invocation only):

Set `ALMA_IOS_DEVICE` to the intended device identifier before invoking a live
command; no developer's device identifier is built into the source. Injectable
model-free transports do not require a connected device.

```sh
node tools/alma-ios-lab/tah_phone_controller/live.mjs validate NEW_OUTPUT_DIRECTORY
node tools/alma-ios-lab/tah_phone_controller/live.mjs inspect NEW_OUTPUT_DIRECTORY
node tools/alma-ios-lab/tah_phone_controller/live.mjs run NEW_OUTPUT_DIRECTORY
```

The signed `Local Agent Probe` must already be installed from the matching
`local_agent_probe/.build/bound` build. The phone's own ChatGPT sign-in is reused;
no desktop credential or API key is copied. `validate` makes no device call.
`run` uses gpt-5.6-luna/low for Guardians and gpt-6.1-sol/native default for Actors,
checking the actual catalog. The full output directories contain private account
usage observations: keep them local/ignored, and share only sanitized summaries.
Vite is used only as a TypeScript module loader, without an HTTP/HMR listener,
and is closed in `finally`. No automatic retry after uncertain device effects.

Each phone attempt closes executor/native-file admission, observes drain without
quarantine, snapshots candidates, writes its report, and exits. The host then
independently observes PID absence and rereads the physical tree. This is not a
general proof against a malicious process, V8 native-memory exploits, arbitrary
concurrent writers, or AFC's symlink dereferencing. Role directories are created
by the trusted importer; current guest/native policy rejects links and root moves.
Long real transcripts and long locked/background Agent execution remain unverified.

Offline tests only, using already installed sibling dependencies:

```sh
node /Users/dashidhy/Public/projects/agent/ALMA/app/TAH/node_modules/vitest/vitest.mjs run --config /Users/dashidhy/Public/projects/agent/ALMA-litter/tools/alma-ios-lab/tah_phone_controller/vitest.config.ts
```

These tests execute original fixture projection/validation functions, never phone
or model attempts and never a fabricated successful workflow. They are runtime
source tests, not a TypeScript compiler check or production build. Passing them
does not establish phone protocol fidelity, authorization parity, full TAH/App
parity, or a native memory security boundary.

Local qualification journal
---------------------------

`file-journal.ts` exports synchronous `createFileJournal(root)`. Its return value
implements the original `JournalPort` plus `close(): void` to release the lifetime
writer lock. In a `finally` block, close persistence/controller work first, then
call `journal.close()`. Methods reject after close. Nothing is auto-wired or run.

Use a dedicated absolute directory owned by this user under the lab's `.cache/`
or `results/`; its parent must already exist. The factory creates the final
directory if absent. An existing directory must be empty or a valid journal;
unrecognized files are rejected, never removed. Original `JournalWrite` validation
is imported directly. Stream IDs appear in metadata but only their SHA256 appears
in record filenames. File payloads retain exact UTF-8 JSON bytes, length and digest.

Each version is an immutable, read-only record with a metadata checksum and
per-stream previous-record digest. Appends validate every existing record, enforce
expectedVersion and stable stream ownership, and detect duplicate operation IDs
across streams. An identical operation returns its original version, including
after reopen; changed bytes or metadata for that ID fail with `integrity_locked`.
That original bridge error makes durable persistence reject integrity failures
instead of treating them as retryable save availability errors.

Publication writes an exclusive temporary file, syncs it, atomically hard-links it
to a previously nonexistent version name, unlinks the temporary name, then syncs
the directory. This avoids rename-overwrite semantics. No new version is
acknowledged before the syncs succeed. The local filesystem must support hard
links and directory fsync; failures are not silently downgraded. A new operation's
already-aborted signal prevents publication; an exact already-committed operation
still reconciles to its receipt. Storage calls are synchronous internally and
cannot be interrupted midway by an event-loop abort.

An exclusive `.writer.lock` is held for the handle's lifetime, with identity checked
before operations and release. A second opener fails. Crash-stale locks are never
stolen automatically, and pending/orphaned data causes a fail-closed open. Inspect
and preserve uncertain data manually before recovery; do not blindly remove locks
or pending files. This initial adapter deliberately has no automatic crash repair.

Limits: this is qualification storage on a trusted local root, not a production
storage/security promise. Root/ancestor topology must not be replaced concurrently.
fsync is used, but no macOS F_FULLFSYNC/device-cache flush or power-cut test was
performed. Checksums detect corruption, not deliberate checksum recomputation;
without an external trusted head, deletion/rollback of the entire tail cannot be
detected. Original durable TAH replay additionally validates transition semantics.
The file format and scan-on-operation implementation are not a large-store design.

`journal-evidence.json` records the eight filesystem tests and original fixture
provenance. They use only this directory's own temporary workspaces. The large
multilingual fixture is the original model-free persistence fixture, not a real
transcript or fabricated successful phone run. This storage follow-up supersedes
the initial `review.json` statement that no journal implementation exists; phone
admission, account inspection and OS-exit verification remain main-owned.
