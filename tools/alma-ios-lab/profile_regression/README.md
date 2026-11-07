# Codex local-profile regression

The maintained source is `ALMA-codex/ios/native/src/alma_local_profile.rs` in the sibling
fork. The retained runner now reads that source and the fork's pinned Codex
release. Current TAH build and acceptance status is in the
[mobile TAH guide](../../mobile-tah/README.md).

## Historical 0.166 implementation record

The observations, source paths and integration status below describe the earlier
implementation stage. They are not a fresh qualification of the current package;
consult the dated milestone record for checks actually rerun during cleanup.

Production source: `shared/rust-bridge/codex-mobile-client/src/alma_local_profile.rs`.
This helper compares the exact current Mac TAH `native-profile.ts` with the
vendored Codex 0.166 registry, and compiles the unchanged production module
against **real** `codex-config`, `codex-features`, and `codex-protocol` crates.
It uses the upstream CLI override builder, recursive TOML merger, strict config
validation, `ConfigToml` deserializer and feature resolver. There are no shadow
config types, copied feature implementations or mocked consumers.

## Contract and wiring for main

This is an opt-in **base capability profile**, not an attempt permission profile.
It enables `shell_tool` and `unified_exec`, disables other optional capabilities,
and leaves 14 engine security/approval/credential/transport controls caller-owned.
It does not set permission profiles, sandbox modes, approval policy, filesystem
roots, shell environment, authentication, provider or model. Main owns frozen
attempt roles/roots, filesystem and network enforcement, and EnvironmentManager.

No production Cargo dependency change is needed: `codex-config` (which reexports
`TomlValue`) and `serde_json` already exist. Main must declare the module and call
it **only in the ALMA local build/path**. A possible module guard for the existing
three remote feature switches is:

```rust
#[cfg(not(any(
    feature = "remote-alleycat",
    feature = "remote-pairing",
    feature = "remote-cli"
)))]
mod alma_local_profile;
```

Replace the ALMA-local goals/realtime startup override list with this call; do
not append the old enabling overrides after it:

```rust
let cli_overrides =
    crate::alma_local_profile::alma_local_cli_overrides(trusted_provider_web);
```

`trusted_provider_web` means the frozen attempt authorizes **official provider
Web**. It does not derive from shell-network permission, model text, an inherited
config, or a UI preference. Pass `false` during bootstrap before an attempt grant
is available. Main must validate the official provider routing independently.
For attempts with different grants, enforce the corresponding profile at each
thread/turn; do not use one Web-enabled server default as authority for all work.

For **both** the bootstrap builder and the managed-config builder, keep the
trusted controller home and environment wiring, use the same CLI overrides, and
load with:

```rust
let resolved = builder
    .cli_overrides(cli_overrides.clone())
    .without_project_context()
    .strict_config(true)
    .build_with_validation(|raw, _harness, _layers| {
        crate::alma_local_profile::validate_alma_local_config(raw, trusted_provider_web)
    })
    .await?;

crate::alma_local_profile::validate_alma_local_effective_features(
    resolved.features.enabled_features().into_iter().map(|feature| feature.key()),
)?;
```

Use the caller's normal error mapping. Do not recover validation failures by
falling back to the default profile. Main must also validate effective Web mode
(`resolved.web_search_mode`), roots/role/environment, and any harness, managed,
thread or turn overrides at the relevant boundary. In particular a harness
`tools_web_search_request` must not substitute for a trusted Web grant. The final
feature check rejects incompatible managed feature results without mutating or
bypassing the requirements. The raw check is deliberately not a general policy
validator.

Use an isolated controller config home. `mcp_servers = {}` and `hooks = {}`
**merge** with inherited tables in this engine; the validator rejects retained
MCP servers and hooks instead of pretending the empty overlay erased them.
It also rejects selected inherited named profiles and unknown/legacy feature
aliases. Preserve this validation on later thread config loads.

## Removed flags and boundaries

All 194 registry keys are explicitly classified: 147 non-removed, 47 removed.
Two deprecated Web flags are omitted and rejected if inherited. The deprecated
but still implemented `use_legacy_landlock` sandbox selector remains caller-owned.
The regression fails if the registry or Mac disabled list changes without review.

Eight names in the Mac disabled list are now removed compatibility flags:
`guardian_ext`, `multi_agent_mode`, `enable_fanout`, `plugin_hooks`,
`remote_control`, `realtime_conversation`, `send_async_message`, `tool_search`.
They are not emitted as fake disabling switches.

**Realtime requires a local dispatch gate.** Codex 0.166 keeps
`RealtimeConversation` default-on and ignores `features.realtime_conversation`
even when false. The tests demonstrate this using the real feature consumer.
Main must reject `thread/realtime/*` and internal realtime operations in the
ALMA lane; this profile cannot disable that RPC surface. Remove the old local
realtime model/version/type overrides. Do not claim realtime isolation until
the gate is wired and tested.

`history.persistence = "none"` disables input history, not thread rollouts or
state databases. Main must request ephemeral attempt threads separately.
`project_doc_max_bytes = 0` suppresses project instructions; use
`without_project_context()` as above to avoid project **config** discovery too.
`allow_login_shell = false` rejects model requests for login shells, while the
trusted shell environment (including startup-file variables) remains main's job.

No default or remote Litter profiles are modified by this unintegrated module.
No Cargo/lib/session/connection files are edited by this task.

## Run and evidence

```sh
python3 tools/alma-ios-lab/profile_regression/run.py
```

The helper runs offline with two jobs, reuses the existing host consumer cache
at `scoped_executor_regression/.build/target`, disables incremental output for
the new harness, and stops at 240 seconds or 768 MiB of observed cache growth
(checked every five seconds). It never cleans another helper's cache. Override
`--target-dir`, `--toolchain`, `--mac-profile`, or the bounds if needed. A missing
offline dependency fails rather than triggering a fetch. The initial consumer
build took 57 seconds and added approximately 724 MiB; subsequent runs reuse it.

`results.json` preserves the last successful run's source hashes, upstream
revision, command and bounds; `last-attempt.json` records later completed or
interrupted runs, and `.build/output.txt` has the latest output. A successful
run also saves `.build/last-pass-output.txt`. The helper refuses a cold build
unless `--allow-cold-cache` is explicit. The tests cover both Web modes, the
effective feature inventory, preservation of trusted actor/guardian grants and
engine controls, inherited MCP/hooks, named profiles, structured feature merging,
unknown/obsolete flags, privacy settings and conflicting resolved features.

These are host config/feature consumer tests. They do **not** execute the full
Core ConfigBuilder, managed-config retrieval, network/model requests, auth,
phone/device code, session integration or realtime dispatch rejection.

Current evidence: all 12 tests passed. A subsequent run was killed with SIGKILL
while the shared target directory disappeared; its output and
`last-attempt.json` record that interruption. The runner was then hardened to
handle disappearing-cache measurements and refuse implicit cold rebuilds. The
production module and Rust tests are unchanged from the successful run; its
recorded runner hash intentionally identifies the pre-hardening runner. No cold
rebuild was attempted after the shared cache disappeared.
