# Historical Kimi compatibility inputs

The standalone C-host research entry points were retired after phone-owned TAH
qualification. They did not exercise the current Rust provider backend. Their
source remains in repository history; dated reports in `results/` and
`INTEGRATION_REVIEW.md` are historical evidence, not current build instructions.

Use [the mobile TAH guide](../mobile-tah/README.md) for the current App and
`ALMA-kimi-code/ios/` for the maintained backend, adapter, runtime preparation
and provider regression checks.

The remaining `prepare_latest.py`, `latest-source.lock.json` and `pipe-host.py`
are retained inputs for existing isolated compatibility fixtures. The old SDK
cache is still consumed by those fixtures; do not remove it as part of an
indiscriminate cache clean. It is not the App's provider source owner or its
recommended runtime packaging path.
