# Session Agent prototype

Current priority, 2026-11-17: **P0 is persistent conversation across Codex, Kimi
and ZCode, plus mapping one Alma conversation to authorization-owned native
threads and aligning context when switching back.** The qualified live baseline
below remains Codex-only build 23. Kimi/ZCode parser checks and role projections
are not completed persistent-runtime integrations.

App-area navigation and linked-file browsing are required but deferred; they do
not gate P0. Only common-format Skills are in scope; provider-specialized Skill
semantics remain future work. See the authoritative [integration priorities](../../../ALMA/frontier/mobile/INTEGRATION_CONTEXT.md)
and [navigation backlog](../../../ALMA/frontier/mobile/NAVIGATION_BACKLOG.md).

The working tree contains unshipped navigation/Quick Look edits. Their
[baseline-aware patch and manifest](../../../ALMA/frontier/mobile/results/navigation-deferred-20261117/wip-manifest.json)
preserve 15 files for later work. They have not been restored out of the working
tree or qualified: isolate/exclude them before the next P0 build rather than
silently treating current sources as the signed build 23 baseline.

User-approved implementation, 2026-11-16. Codex-only free conversation in the
existing Alma TAH app. Application-owned skills ship as signed App folder resources under
`skills/builtin-v1` and are installed once at the shared application location,
never into a session or authorization directory. Skill text is not embedded in
the Rust library: later prompt/resource-only updates reuse the native archive.

The native Rust service owns workspace identity, conversation records and Codex
thread bindings. React presents them; Swift supplies lifecycle and existing
ChatGPT authorization. The old TAH action/guardian/revision path remains separate.

Business files are read-only except `assets/`, which the agent edits directly.
Web is enabled by default. Shared skill instructions and provider private state
are not editable business assets. Ordinary QA has no mandatory ASR-review gate;
the notes skill requests review when its shared outputs are missing/incomplete.
Skills are composable capabilities, not a fixed execution pipeline. The agent
chooses their timing and may interleave work or file writes. Acceptance checks
the complete, consistent end result, not review-before-notes write ordering
(user clarification, 2026-11-16).

`builtin-v1` is currently an unpublished package under qualification. The App
installs its own canonical build contents into the one shared directory; model
tools cannot write that directory. Released package content changes must use a
new package version rather than silently redefining a published version.

Baseline: ALMA-litter `887d23a504ff090c9334245ce3fe9e18f67399c1`, ALMA-codex
`2f2f9536a261d2b4e03feb42e6e1a1d97f188eb4`. Work branches:
`codex/session-agent-shared-skills`. SDK versions are unchanged.

Core-flow qualification is complete on iPhone 12 Pro with real Codex and NVIDIA
source data. See [qualification evidence](QUALIFICATION.md). Build 20 includes
the two-table ASR report and App-bundled shared Skill resources. Build 21 adds
application-owned [role and capabilities configuration](ROLE_AND_CAPABILITIES.md),
preserving the current prompt and verifying two ordinary turns plus cold resume
on the same Codex thread. Kimi/ZCode configuration projections are prepared;
their new persistent-session runtimes are not connected. Deferred items
are listed separately and are not claimed as tested.

Current scope update: network/disconnection and broader exception-handling discussion/testing are deferred by the user. Corrected-transcript timestamp/merged-turn UI is also deferred. The core flow includes the [two-table ASR Review format](ASR_REVIEW_PRESENTATION.md).

Build 22 restores the [legacy TAH chat and composer presentation](CHAT_UI.md) for the Session Agent; a separate transcript-only workspace is reserved for the user to try from the first message.

Build 23 restores the original [per-turn Working events presentation](WORKING_EVENTS.md), including the shared live disclosure and full log panel. Real user history, two live turns and restart were checked; a new transcript-only workspace is ready for user testing.
