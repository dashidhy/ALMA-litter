# Alma TAH phone frontend

For integration into the complete mobile app, start with the [mobile frontend integration notes](../../../docs/ios/frontend-integration-notes.md). They collect the user-confirmed interaction direction, implemented fixes, reusable files and remaining acceptance work.

React UI for the existing native TAH presentation controller. Native owns authorization, consent admission, action state, progress, model catalogs, revision publication, material loading, and persistence. This frontend does not call a cloud provider or reproduce the business state machine.

## Run and build

```sh
cd apps/ios/tah-ui
npm ci --registry=https://registry.npmjs.org --ignore-scripts
npm test
npm run build
npm run dev
```

The dev server binds to `127.0.0.1:1437`, matching the native Tauri configuration. The production build writes `dist/`, matching native `frontendDist: "../dist"`. Native packaging combines Tauri and the existing Codex backend in one Rust library. See [`tools/mobile-tah/README.md`](../../../tools/mobile-tah/README.md) for the signed iOS build and preserved-container migration.

- `/`: native UI; clearly reports an unavailable native connection in a normal browser.
- `/qa.html`: explicitly selected, **development-only** visual fixture. Installs the fixture before mounting the same React app. The visible “Preview data · 预览数据” banner identifies it. Includes Chinese headings, nested lists, GFM tables, a long ASR table, code overflow, notes/ASR/source switching, and editable interaction language, web setting, and appearance.
- `npm run build` uses only `index.html`. It does not emit `qa.html`, `src/qa.ts`, or fixture data. Production ignores `window.__TAH_UI_FIXTURE__` even if another script injects it. There is no query-parameter or missing-native fallback.

The QA fixture records commands and acknowledges Send with a busy snapshot. It does not simulate completed work. Reload `/qa.html` to reset the fixture. Its catalog and sample publications are test data, never production choices.

## Native transport

`src/bridge.ts` exports the typed `call(method, value)` boundary. It calls:

```ts
await invoke('tah_ui', { method, value }); // value is an object, not JSON.stringify(value)
```

Every command, including `snapshot`, returns the immediate authoritative object:

```ts
{
  presentation: Presentation,
  draft: Draft,
  ready?: boolean,
  error?: string | null
}
```

Omitted `ready` means normal operation. Only `ready === false` selects the startup screen. Startup can expose `presentation.isBusy`, `status: "preparing"`, and a top-level sign-in error; Sign in with ChatGPT dispatches `signIn {}`. A command response acknowledges admission, **not completion**. The UI applies that snapshot immediately and polls for further changes. Optional presentation and draft fields are explicit JSON nulls, matching `TAHWebPresentationBridge.swift`.

The public types in `src/contract.ts` mirror `TAHPresentationContract.swift`, with web timeline `{id,title,text,markdown,detail,canExpand,role?,revisionIndex?,phase?,working?}`, optional `currentActivity` / `workingLog` projections, and material `{id,title,text,markdown,isLoading,error}`. No native model handles, reasoning IDs, configuration labels, revision indexes, permission flags, or progress events are invented by the frontend.

| Command | Value |
| --- | --- |
| `snapshot`, `refresh`, `inspectAuthorization`, `checkpointDraft`, `dismissMaterial`, `signIn` | `{}` |
| `selectTranscript`, `selectAction` | `{id}` |
| `importTranscript` | `{title,text}`; complete literal UTF-8 text |
| `updateDraft` | `{draft,context}`; context is `{actionID,editorToken}` or null |
| `selectInteractionLanguage` | `{language}` (`en` / `zh-CN`) |
| `checkRawSafety` | `{transcriptID,consent,interactionLanguage}` |
| `createStructuredNotesAction` | `{transcriptID,language,settings}` |
| `sendAction` | `{context,instructions,settings,initialLanguage,interactionLanguage,consent}` |
| `loadMoreConversation` | `{actionID}` |
| `expandConversation` | `{actionID,itemID}` |
| `readMaterial` — source | `{kind:"rawTranscript",actionID,revisionIndex:null,file:null}` |
| `readMaterial` — output | `{kind:"outcome",actionID,revisionIndex,file}`; file is `structured-notes.md` or `suspicious-asr-terms.md` |
| `openWorkingLog` | `{actionID,position}`; position is null for current activity or a positive native history position |
| `refreshWorkingLog`, `closeWorkingLog` | `{id}`; the explicit native log identity |
| `openExternal` | `{url}`; HTTP(S) without credentials, only following a trusted user click |

Appearance uses the separate native command `invoke('tah_theme', {dark})`. It changes the web palette immediately and reports native theme failures visibly. The development fixture does not invoke native theme handling.

## Draft and polling behavior

`src/controller.ts` serializes transport calls and retains only temporary editor text. It polls every 750 ms while native reports busy, loading material, or startup, and every 4 seconds when idle. Commands schedule a follow-up poll at 750 ms. Transport-pending controls suppress duplicate taps; they do not fabricate business progress.

Local draft changes debounce for 250 ms. An explicit Send first flushes `updateDraft`, accepts the native draft/settings response, verifies the selected transcript/action/editor-token identity, checks current native permission, then sends. When edits overlap an acknowledgement, only fields changed since the outgoing draft are applied over the native response. This preserves native model defaults for effort/context while retaining newer Web or instruction edits. Changing transcript/action also flushes the old draft before selection. Background visibility and settings dismissal request `checkpointDraft`; native failures remain visible. Native remains the final validator.

An empty v0 is allowed only when native `canOmitInstructions` and `permissions.send` allow it. Later revisions require nonblank instructions. Text is sent unchanged, including whitespace. Output language locks according to `initialSettingsFrozen`, and frozen submissions use `initialLanguage:null`. Reasoning options display and submit catalog **IDs**, not explanatory titles. Web and interaction language remain separate controls.

## Chat and working events

The default conversation style follows the approved double-colored bubble prototype: user messages on the right, Alma replies on the left, with no revision separator lines or outer revision frames. Settings retains a lightweight alternative. The versioned `alma.tah.chat-style.v1` local preference stores only `{version:1,style:"bubbles"|"light"}`; storage access is guarded, and unavailable storage does not block the UI. Roles come exclusively from native `TimelineItem.role`; missing legacy roles render neutrally, never by parsing titles. User text remains literal regardless of its Markdown flag. Each accepted revision retains Notes and ASR terms buttons, including revisions whose conversation messages have not yet been paged in.

`WorkingSummary` drives the live disclosure: initially expanded, latest three public events, native Progressing, and the full-log entry when `canOpen` permits it. Completed/published messages display elapsed time only from valid native timestamps and a direct full-log link, without an inline event disclosure or synthetic summary nodes. Guardian phases are not presented as Actor work. Public event filtering matches the original Mac UI: Actor events plus the explicitly identified successful extra-safety outcome; event details are always literal text.

`WorkingLogPanel` uses the shared main-owned `Sheet` without duplicating its gesture wrapper. The original Mac `event-log-scroll.ts`, `manual-scrollbar.ts`, and `useEventLogScroll.ts` behavior is adopted for a bounded log: follow the end until upward user intent, preserve history position across native refreshes, and resume only on a real return to the end or the fixed-height “Latest events” footer. Refreshing a populated log does not insert a loading row. Native read failure preserves loaded events and does not hide Progressing while native still reports activity; superseded logs suppress the progress tail. Native failure/limit/superseded notices remain visible.

Opening requires a new native log identity matching the requested action and position. Only the selected loading/progressing log is refreshed, at the normal 750 ms busy cadence. The panel keeps its native ID and scroll state when the same action receives a new editor token on publication. Changing transcript/action clears the route. Closing clears the local route immediately and queues `closeWorkingLog{id}` behind any read, bypassing the ordinary pending-command gate; a late read cannot reopen the sheet, and an old close cannot dismiss a newer log. Draft editor-token validation remains unchanged. Settings changes now persist on change; dismissing the sheet does not checkpoint.

## Rendering and interaction

Keyboard layout is local presentation only. `src/viewport.ts` and `src/useViewport.ts` size the fixed shell to the smaller layout/visual viewport height, clamp its top offset, and provide a separate bottom inset for top-layer dialogs. Native layout resizing is not subtracted a second time. Visual viewport resize/scroll and window resize events drive updates; a bounded 900 ms frame loop around focus/blur catches first-focus and dismissal animation. Restored full height clears stale iOS viewport offsets even if the input remains focused. Listeners, pending frames, observers, and style variables are removed on unmount. The code never scrolls the page, changes focus, or mutates draft text.

The textarea, labels, and existing controls share one floating rounded composer card. Its keyboard gap is 8 px, without home-indicator padding while the keyboard is present. A ResizeObserver reserves the card's actual height in the independent conversation scroller, keeping its final entry reachable while content can pass behind the card. The restrained frosted surface uses CSS backdrop blur with an opaque fallback and `prefers-reduced-transparency` support; it is not native Apple Liquid Glass. Native accessory removal and root background remain host-owned. A compact “Hide keyboard” icon appears within the existing controls row while the card contains focus; it prevents pointer-down focus transfer and blurs the textarea on activation without editing or sending text. There is no extra toolbar.

- Alma Preview colors: ink `#131613`, paper `#faf7ef`, lime `#dfff79`; compact 44 px header, 44 px interactive controls, safe-area insets, a persistent composer, and scrollable settings/library sheets.
- Separate material page with Notes / ASR terms / Transcript controls and a native revision selector. A read switches the selected material only when the returned material ID is new, the selected action matches, and the native title matches the requested file/revision (`Raw transcript`, `vN · Notes`, or `vN · ASR terms`). An unchanged or mismatched response reports a failure and keeps the selected tab; it never labels old content as the requested material. Subsequent reader snapshots must keep the admitted ID and target title. Loading, failures, and results come from material snapshots. Full source and expanded conversation reads go through native commands.
- Sign-in appears only on the startup/not-ready screen. Settings offers authorization inspection, not account replacement.
- `marked` parses GFM; DOMPurify sanitizes the result with an explicit element/attribute allowlist. Source HTML is escaped before DOM creation. Images become inert text placeholders, and CSP blocks image/media/frame loads.
- `markdown:false` renders plain React text with preserved whitespace. Raw transcripts and user instructions never become Markdown by inference.
- Links allow only absolute HTTP(S) URLs without user info. Script, data, file, IPC, relative, and mailto links are inert. Trusted clicks dispatch `openExternal`; default browser navigation, auxiliary navigation, and link context-menu navigation are suppressed. Nothing fetches a linked URL on render.
- Tables and preformatted code have independently focusable horizontal scroll containers. The overall page does not grow to fit a wide cell or code line. No remote fonts, syntax-highlighter runtime, browser engine, or cloud SDK is shipped.

Dependency provenance: React 19.3.0, Tauri API 2.12.1, TypeScript 7.0.2, and marked 18.0.9 reuse existing local reference pins. `dompurify` was patched from 3.4.13 to 3.4.17 and Vite from 8.3.2 to 8.3.5 after the official npm audit reported advisories on the reference pins. All lockfile downloads use the official npm registry. The Mac reference was not modified. Renderer API references: [Marked](https://marked.js.org/using_pro), [DOMPurify](https://github.com/cure53/DOMPurify).

## Verification

Latest frontend checks:

- `npm test`: **137 passing tests** across bridge, controller ordering, stale editor identity, empty v0/later revision validation, explicit consent, polling cadence, startup/sign-in, native material updates, strict raw payloads, literal text, GFM rendering, blocked resources, and unsafe links. The read-admission and model/Web overlap tests reproduce the reviewer’s native-shaped races; additional cases cover wrong file/revision/action and newer explicit effort edits. Seventeen viewport tests cover first-focus animation, native versus visual resize, offsets, different keyboard heights, blur/reopen, stale-offset restoration, zoom/rotation, missing VisualViewport, no text mutation/page scrolling, and listener/frame cleanup. The added chat/log tests cover style persistence and storage failure, explicit roles, per-revision materials, live-to-completed transitions, literal event privacy, read failures, stale admission/close, token-change retention, manual history reading, and stable footer behavior. Main’s shared-sheet gesture/DOM tests are included. Actual keyboard appearance and iOS accessory removal are verified by the host task on device.
- `npm run build`: passed, including the corrected shared-sheet test typing. Release assets are rebuilt and embedded in the signed native app; see the current phone chat acceptance report below.
- `npm audit --registry=https://registry.npmjs.org`: **0 vulnerabilities**.
- Browser QA at 390×844 and 320×640: compact action screen, ink/paper settings, notes/ASR/source switching, frozen output language, exact reasoning IDs, revision selector, and native-link dispatch. At 390 px, a code block measured 938 px within a 344 px scroller. At 320 px, the wide table stays inside a 274 px scroller; the document remains 320 px wide. No page exceptions or image fetches occurred.

Browser checks use an explicitly injected fixture, not a native/device integration claim. The host task performs iOS packaging and phone verification. No native build, device call, Git commit/push, or edit to the Mac reference was performed by this frontend task.

## Actual phone verification (2026-11-01)

The production frontend is installed in the existing `com.alma.litter.agent-probe` container on the iPhone 12 Pro, iOS 27.0.1. Real SAM v0 data renders headings, paragraphs, bold lists and links; Notes, ASR terms and timestamped plain Transcript load distinct native materials. The real ASR table scrolls horizontally without widening the page. Native settings show exact effort IDs (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`), separate interaction/output languages, frozen output language for the existing action, and Web. Ink/Paper switching works. No new model task was started to verify these readers.

A stale SwiftUI scene-restoration cache caused the first in-place upgrade to show a blank window. After backing up and removing only that cache, Tauri launched normally. The App was not uninstalled. Before/after original journal events and chunk bytes are identical, with 7 publications and 0 pending writes. See the native reproduction guide and `tools/mobile-tah/results/2026-11-01-tauri-ui-acceptance.json`.

## Mobile log scrolling regression (2026-11-01)

Content pointer gestures (mouse, pen, or touch, including descendant event text) now pause tail-follow immediately without pointer capture or preventDefault. Existing touch handlers also pause before compositor scrolling; stationary moves are ignored, and gesture-end notifications cannot re-enable following against a stale bottom position. Actual downward return to the end or Latest events resumes follow. Sheet header gesture handling is unchanged. Six additional regressions cover these input paths, delayed native scroll ordering, Latest visibility/resume, native content scrolling, and cleanup. `npm test`: 124 passed; `npm run build`: passed. After the shared-heading focus correction, final assets are `index-DeLLz5aG.js`, `index-AwF59jeN.css`. Physical SAM v0 history scrolling now remains at the manually selected position; Latest events returns to the tail. Both Settings and Working events close by pulling the header down.

## Chat and shared-sheet phone acceptance (2026-11-01)

Build 0.2.0 (5) adds the chosen double bubbles, persisted Lightweight alternative, native full working logs, and shared Preview-derived sheet gestures. One original-framework synthetic revision v3 completed on the phone; the existing eight publications remain intact. Running latest-three events are covered by component/projection checks, but were not captured visually during that physical revision. The static sheet h2 receives initial accessibility focus without a button-like outline; actual controls retain their focus indicators. Evidence and limitations: [chat acceptance](../../../tools/mobile-tah/results/2026-11-01-chat-ui-acceptance.json).


## Reduced-motion audit (2026-11-02, superseded motion policy)

Reduce Motion preserves necessary feedback: spinners use opacity pulsing, sheet automatic dismissal fades in place, and a cancelled pull repositions while hidden before fading back. Direct finger tracking, keyboard geometry and event-log updates remain functional. Settings/Library/Working Events share this policy. Busy states without a phase retain text, local file reads announce activity, and `PendingCommandStatus` displays UI request waits both in the main page and inside top-layer sheets without claiming model execution has started.

The actual Tauri package was audited; unused SwiftUI/Litter screens are not part of that runtime. `npm test`: 131 passed; production and iOS builds passed. See [frontend integration notes](../../../docs/ios/frontend-integration-notes.md) and [audit evidence](../../../tools/mobile-tah/results/2026-11-02-motion-audit.json) for the scope and physical verification.


## Current motion policy (2026-11-02)

The user rejected the fade/reposition sheet behavior as flickering and uncomfortable. The App-owned frontend now ignores system Reduce Motion: it has no `prefers-reduced-motion` media rule or JavaScript query. Spinners always rotate; sheets always use the normal continuous slide/rebound. The opacity-pulse keyframes and fade/reposition path are removed. Preserve the independent reduced-transparency rule, system-owned UI behavior, status text and pending/file-read feedback. The earlier audit is historical evidence, not the current motion recommendation. See [normal-motion update](../../../tools/mobile-tah/results/2026-11-02-normal-motion.json).


## Settings save/close behavior (2026-11-02)

Settings draft edits use `editSettings` to flush and persist on change. Interaction-language changes also persist before acknowledgement; reading theme and chat style save locally on selection. Closing Settings performs no save. Quiet persistence shares the existing transport queue without publishing global pending or accepting a transient save snapshot that can overwrite newer edits or flash busy controls. Following user commands queue normally; save errors remain visible. Sheet backdrop changes now transition alongside the slide, and focus restoration prevents scrolling. [Evidence](../../../tools/mobile-tah/results/2026-11-02-settings-close.json).


## Model labels (2026-11-02)

All providers use the same rule: show the catalog display name, falling back to the model ID when that name is absent or blank. Do not concatenate both into duplicate UI text. Settings option values, stored drafts and provider requests continue to use the original ID. Composer labels follow the same rule; historical revision labels resolve names only within their own provider, otherwise fall back to their recorded ID. This does not change the standard reasoning-level labels.
