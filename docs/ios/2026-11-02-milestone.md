# ALMA phone-owned Codex / TAH prototype milestone

2026-11-02 · `dev/ios` · iPhone 12 Pro qualification.

## Accepted scope

The current prototype independently executes the existing Alma TAH + Structured
Notes normal foreground workflow on the phone: Raw Guardian, Actor, Extra
Guardian, Critic, accepted output publication and multiple revisions. Language,
model, reasoning effort and official Web settings retain the Mac contract.
The Mac is a development/install/observation host, not the task scheduler.
Model inference uses the user's provider subscription over the network.

- Base fork: Litter 2.1.9, `366aefdd616f16b9efb6c888be6cfd916bda47d6`.
- Embedded Codex: 0.166.0, `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`.
- iSH input: `4f783cd957b83de3019d6a843408d5bb3ff902c7` with owned patches.
- This is a pinned qualification baseline, not a rolling claim of latest CLI
  parity. Only the local iOS lane is accepted.

The original TAH core runs in trusted JavaScriptCore. The Codex Adapter owns
native-profile/RPC/event mapping; Rust owns the embedded runtime, scoped native
files and iSH execution. Model-generated Code Mode JavaScript runs in a separate
native V8 engine with JIT disabled. A sealed tool environment is reused across
fresh per-attempt scopes; normal completion drains tools before capture/disposal.
Credentials stay native; trusted JavaScript uses revocable opaque handles.

## Evidence

- Synthetic and full NIST phone workflows each completed V0/V1/V2 and six output
  files. Configuration/Web and revision semantics were independently read back:
  [synthetic](../../tools/mobile-tah/results/2026-11-01-phone-core-synthetic.json),
  [NIST](../../tools/mobile-tah/results/2026-11-01-phone-core-nist.json).
- User testing covered SAM and NVIDIA; the normal workflow, multiple revisions
  and usability meet the present use case. The reported 16-minute unplugged run
  with no displayed battery drop is an observation of rounded battery display,
  not a zero-energy measurement.
- Native-byte operations, event-driven state updates and bounded Working Events
  deltas remove repeated display work. Official Tauri Channel uses consumer ACK
  and bounded queues. Core/Swift burst tests cover 10,000 updates, and phone live
  and historical views were verified. See [Channel evidence](../../tools/mobile-tah/results/2026-11-02-working-channel.json).
- The subsequent silent-draft update passed 186 frontend tests and the complete
  device build, was installed in place, and preserved 127 journal records plus
  saved drafts/settings. UI decisions are in the [integration memo](frontend-integration-notes.md).

These are distinct evidence scopes; fixed probes, source checks and model-free
replays are not labeled as live long-task or background acceptance.

## Reproduction and repository contents

Start with the [mobile build recipe](../../tools/mobile-tah/README.md).
Committed inputs include the owned TAH source and vendor locks, synthetic replay
fixtures, native code, patch stacks, preparation/test scripts and compact results.
Build caches, model/rootfs binaries, generated bindings/projects, raw device
reports and private recording/account data are excluded. Downloads and native
build preparation are explicit; the recorded prepared-cache build is not a
claim that a new machine has been rebuilt from an empty cache.

The close-out review reconstructed all 33 changed Codex paths from the 0.166
base plus 10 patches, and all 522 owned iSH source files from six patches. The
124 owned TAH files and 735 vendored dependency files match their locks. The
parent repository records the public Codex base gitlink and reproducible patches;
the applied local submodule remains dirty by design and is not separately pushed.

## Remaining boundaries

- Full background/physical-lock execution, interruption recovery and the complete
  fault matrix remain unqualified.
- Two newly identified P2 exception paths—refresh-to-next-bootstrap credential
  synchronization and inspection-start failure scope cleanup—are recorded with
  concrete fixes/acceptance requirements in the [risk register](../REPOSITORY_AUDIT.md).
- Native V8 lacks desktop memory-sandbox parity; scope/tool checks do not provide
  VM-equivalent exploit containment. Existing dependency findings remain open.
- Arbitrary desktop packages, full Codex CLI capabilities, other providers,
  Android and remote modes are not covered.
- ASR, segment summaries, automatic title generation and the full Alma Preview
  app are not yet connected to this prototype. Existing log-retention limits
  remain; unlimited history/pagination is not claimed.

The ALMA sibling repository keeps only Frontier research/history and the
cross-repository milestone pointer. Its unrelated App/release work is outside
this close-out commit.
