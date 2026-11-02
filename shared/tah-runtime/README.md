# Mobile TAH runtime ownership

The `upstream/` snapshot is explicitly adopted from the current Mac App TAH.
`source-lock.json` records exact source hashes. Shipping bundles read only this
owned tree, never sibling Mac source or the earlier qualification controller.

Layer boundaries remain **TAH Framework → Provider Adapter → Provider backend**.
Framework, Guardian decisions, action definitions, instruction ledgers, critic and
publication rules stay provider-neutral. Provider-specific RPC, capability mapping,
authentication and event normalization belong to the provider adapter. The backend
supplies native Codex App Server and scoped tool execution. Swift owns UI/platform
services and must not implement a second workflow state machine.

This work prioritizes the full phone-independent foreground normal path. Existing
authorization/file boundaries remain intact. Broader failure/background matrices
are deferred per the user's latest instruction; no silent boundary downgrade.

The foreground phone-owned core path now passes live qualification on iPhone 12 Pro:
synthetic transcript and the complete 27-turn NIST transcript, each through V0/V1/V2.
Original Framework and publication code run in JSCore/SQLite on the phone; Codex
Adapter drives the native backend. The Mac only builds, installs and observes.
See `tools/mobile-tah/results/2026-11-01-phone-core-*.json`. This is not a release,
background/lock or full desktop-CLI parity acceptance.
