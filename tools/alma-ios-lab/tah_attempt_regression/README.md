# TAH attempt import differential regression

The harness uses the **actual unchanged** production `tah_attempt.rs` and
`scoped_files.rs` through Rust `#[path]` modules, with real UniFFI scaffolding.
There is no copied validator, filesystem implementation, mobile runtime, phone,
auth, model or network delegate.

`generate.test.ts` invokes the original Mac TAH `buildRawGuardianAttemptV1`,
`buildActorAttemptV1`, `projectNativePromptChannelsV1`, original schema validator,
and existing controller `loadFixture`/`projectPhonePayload`. It uses their exact
serialized attempt and material bytes. Fixtures contain a synthetic transcript,
Unicode text, a clearly fictitious model, and dummy `a*64`/`b*64` identities;
these are not authorization or account evidence.

The outer transport envelope uses `runID`, `attemptJSON`, and `attemptSHA256`,
matching the host port. The embedded original FrozenAttempt JSON is **not**
renamed. Rust now explicitly preserves the original uppercase `ID` acronyms.

## Recorded result

After the explicit field-name fix, **all eight groups pass**, including original
Raw/Actor imports and every negative case below. `results.json` and `cases.json`
contain the current evidence. `serialization-bug.json` preserves the initial
failure and its source hashes; the following records that initial diagnosis.

See `results.json`, `cases.json`, and `serialization-bug.json` for the tested
source hashes and exact evidence. The original TS fixture generation passed and
the offline host Rust harness compiled. Of eight case groups:

- Original valid Raw Guardian and Actor imports: **failed**.
- Malformed manifest creates no workspace/output: **passed**.
- Wrong hashes, extra/missing/duplicate files, escaped/noncanonical paths, reused
  attempt ID and prompt-channel mismatch: **blocked by the valid-import failures**.
  Their early rejection is not counted as proof of the intended later checks.

The confirmed blocker is acronym spelling in production's derived deserializer:

| Original FrozenAttempt field | Old automatic Rust camelCase expectation |
|---|---|
| `attemptID` | `attemptId` |
| `providerID` | `providerId` |
| `inference.modelID` | `inference.modelId` |
| `inference.reasoningEffortID` | `inference.reasoningEffortId` |

A diagnostic renaming only these four properties and updating the envelope hash
was accepted by the unchanged production module. That payload is deliberately
**noncanonical** for the Mac contract and is not counted as a valid-import pass.
The minimal production correction for main to review is explicit Serde field
renames to the original `...ID` spellings. This harness does not edit production.

## Run

```sh
python3 tools/alma-ios-lab/tah_attempt_regression/run.py
```

The script returns nonzero for failed or blocked groups. It uses existing Mac
TAH node_modules, cached Rust dependencies only (`--offline`), two Cargo jobs,
an external 180-second build/test deadline and a 1 GiB private-cache ceiling.
All generated fixtures, native files, Cargo metadata and artifacts stay under
this directory's `.cache`. No shared target or Cargo/global configuration is
modified. The source hashes must remain identical from start to finish; a
parallel production edit invalidates that run rather than being attributed to
the recorded source.

The eight groups are implemented and ready to rerun against main's fix.
`capture_candidates` is compiled using the actual ScopedFiles module but is not
exercised. Extra Guardian, seeded V1/V2, live Web, physical-device behavior, and
the complete TAH workflow remain unverified. “No I/O on bad manifest” means no
workspace/output creation or mutation; the required inbound file read is allowed.
