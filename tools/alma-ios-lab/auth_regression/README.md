# Refresh account-consistency regression

From the ALMA-litter root:

```sh
python3 tools/alma-ios-lab/auth_regression/run.py
```

This is a host Swift test with dummy account IDs and deliberately unusable,
unsigned token fixtures. It does not log in, access Keychain, perform network
requests, use a device, or build the full iOS application. All generated files,
compiler/module caches, and results stay under this folder's ignored `.build/`.

## Narrow production fix

`ChatGPTOAuth.refreshStoredTokens` previously rejected only when **both** the
refreshed and stored accounts differed from the nonempty expected account.
That accepted and saved refreshed B when expected A and stored A.

The guard now compares the refreshed account directly with the supplied
nonempty expected account before saving. The cached account cannot authorize
a mismatch. No concurrency, networking, storage, logging, or event-integration
code was changed; the existing `@MainActor` isolation is preserved.

Missing-value behavior is intentional and otherwise unchanged:

| Inputs | Result |
| --- | --- |
| Nonempty expected ID, different refreshed ID | `refreshAccountMismatch`; no save |
| Refreshed ID matches expected ID, including a stale/different stored ID | Save and return refreshed bundle |
| Nil or empty expected ID | No account pin; accept a valid refreshed account (existing restore callers pass nil) |
| Whitespace expected ID | Still a nonempty exact ID; no new normalization |
| Missing/empty/blank refreshed account claims | Existing `tokenBundle` validation throws `missingAccountID` before saving |
| Missing stored bundle | `missingStoredTokens`; no exchange or save |
| Nil/empty stored refresh token | `missingRefreshToken`; no exchange or save |
| Missing/blank access token or ID token | Existing token validation rejects before saving |

`accountID` in a token bundle is a nonoptional String. The tests cover absent
account claims through the real token parser, rather than inventing an
optional refreshed account field. Existing access-token claim fallback is
also exercised. The supplied expected ID remains the authority; this change
does not impose a new stored-account fallback when no expectation is supplied.

## Actual test scope

`run.py` extracts these declarations verbatim from the working Swift source:

- `ChatGPTOAuthTokenBundle` and `ChatGPTOAuthError`.
- The complete async `refreshStoredTokens` method, including load/exchange,
  validation, save, and return ordering.
- `tokenBundle`, `resolveAccountID`, `resolvePlanType`, and `decodeJWTClaims`.

The methods remain inside an `@MainActor` enum. `Harness.swift` substitutes an
in-memory token store and a refresh exchange that feeds dummy payloads into
the actual token parser. The real network and Keychain implementations are
not compiled. Each scenario checks the result/error, exchange/load counts,
refresh-token fallback, and save effects. Rejections must leave the stored
bundle unchanged and make zero saves. Test output contains scenario/check
names only; the runner scans for fixture credentials/account data and
requires empty runtime stderr.

The host compiler runs in Swift 5 language mode with targeted concurrency
(matching the project's Swift 5.9/targeted settings), and separately in Swift
6 mode with complete concurrency checking. Both use warnings-as-errors.
This is not a Swift migration or a claim that the full application builds in
Swift 6.

A test-only generated copy restores the audited `stored.accountID !=
previousAccountID` conjunct. The same expected-A/stored-A/refreshed-B test
must fail against that copy, proving that the test detects the original bug.
This negative control never modifies the production file.

## Recorded evidence (2026-11-01)

Apple Swift 6.4.2 on arm64 macOS:

- Swift 5/targeted: **27 scenarios passed**.
- Swift 6/complete: **27 scenarios passed**.
- Original-guard negative control: **failed the regression as expected**.
- Runtime output scans passed; successful compiles emitted no diagnostics.
- `git diff --check` passed for the production change.

`.build/evidence.json` records the compiler, production/extracted-source
hashes, mode results, and negative control. Individual compile/stdout/stderr
files remain alongside it. No real OAuth service behavior, Keychain behavior,
auth-event wiring, retries, or account restoration integration is validated
by these isolated tests.
