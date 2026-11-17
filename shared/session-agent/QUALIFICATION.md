# Session Agent qualification — 2026-11-17

Qualified iPhone build: **0.5.0 (37)**. This is the independent Session Agent prototype inside the existing TAH test App.

| Component | Stable source |
| --- | --- |
| Codex | 0.169.0, `d32063f96c2dff1dc96af839b3952abb6acfeda4` |
| Kimi CLI / SDK | 2.6.2 / 0.23.1, `6a8493df3e1d796a63f7c7ca0de76c1e690cd943` |
| ZCode | 3.18.2, `fec975905a2abd4c07e35c40d51fa097a2258ec9` |

Use the fork commits in `provider-checkpoints.json` together with this App branch. Fetch each pinned official release tag from its upstream repository for the source-identity checks; ordinary branch pushes do not publish release tags.

## Review and verification

- Reviewed Rust session ownership, local inference configuration, authorization bindings, native persistence, event projection, shared Skill discovery and file boundaries against the old TAH adapters and the pinned provider sources.
- Model and effort selection persist locally without opening/resuming a runtime or adding a conversation event. The next admitted request uses the saved selection. ZCode reapplies it after native resume; Kimi checks its applied native configuration; Codex passes it on `turn/start`.
- ZCode's 90 official event types are explicitly classified. Public tool-round text is retained and deduplicated; private reasoning and request bodies are not chat rows. Actual SDK output with public text and a tool call was projected through the Rust adapter in a regression check.
- Kimi's new `tool.updated` events and actual Skill activation are supported. Its mobile-only MCP compatibility patch restores inline file tools that otherwise miss the initial SDK tool snapshot. The mobile executor remains serial; actual SDK mixed-tool tests observed maximum concurrency one, with the upstream unset/off controls retaining parallel execution.
- The existing TAH working-event components and preview limits remain in use. Queued ZCode tools still display `running`; Agent commentary and Skill choice remain Agent-owned.
- All three providers passed real iPhone QA, web access, shared-Skill file generation, old-thread resume after the SDK update, and cold App reopen with the same native thread and remembered conversation context. Actual Codex native turn metadata and Kimi/ZCode native configuration receipts confirmed the selected models and effort.
- Frontend tests, shared Rust session tests, native scoped-file regressions, provider SDK/adapter tests and ZCode's type/lint/architecture gates are recorded in local qualification evidence. Codex source checks classify all 215 upstream features and verify version/patch identity.

ZCode's pre-push lint, schema and architecture gates passed. The upstream affected-test selector chose all 169 engineering specs for the release-wide diff and intentionally skipped that broad suite; it was not counted as a test pass. The mobile SDK/adapter/runtime checks above were executed separately.

## Fresh manual-test state

At the user's request, the old phone test sessions and their native provider states were removed. The App now has exactly one fresh workspace for each provider. Each contains the unchanged NVIDIA transcript, an empty `assets/` directory, and no user/assistant messages. All three native threads opened successfully using the existing authorizations; no model inference was sent during preparation. The shared Skill package remains a single App-owned installation.

The phone opens on Codex. The settings panel lists the three empty workspaces; select the desired provider's existing workspace to begin.

## Scope and evidence handling

Provider/account handoff, broader navigation changes, and new offline/background policies remain deferred. Previously unrecorded intermediate messages are not backfilled. This qualification does not claim production release readiness for the whole Alma App.

The existing exception-recovery findings in `docs/REPOSITORY_AUDIT.md` (credential refresh across a later bootstrap and early inspection-failure cleanup) remain separately tracked; normal-path qualification does not close those items.

Reusable tests and manifests are versioned. Raw phone conversations, native state backups, screenshots and per-run build/device reports remain local under ignored test-output directories; they are not needed to build the prototype. Signed build 37, its source/input manifests and the deliberately retained build 36 rollback are kept locally. The iOS source and build instructions remain in their existing repositories; this work does not reorganize them.
