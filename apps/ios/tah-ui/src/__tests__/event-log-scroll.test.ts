import { expect, test, vi } from "vitest";
import { createEventLogScroller } from "../event-log-scroll";
import type { EventLogScrollState } from "../event-log-scroll";

class Viewport {
  clientHeight = 200;
  scrollHeight = 1000;
  top = 0;
  blockWrites = false;
  writes = 0;
  get scrollTop() { return this.top; }
  set scrollTop(value: number) {
    this.writes++;
    if (!this.blockWrites) this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }
}
function fixture() {
  const viewport = new Viewport();
  let state: EventLogScrollState = { following: true, atBottom: true };
  const changed = vi.fn((next: EventLogScrollState) => { state = next; });
  const scroll = createEventLogScroller(viewport, changed);
  return { viewport, scroll, changed, state: () => state };
}
test("initial follow and new snapshots use actual dimensions without an animation frame", () => {
  const frame = vi.fn(() => { throw new Error("Frames are suspended"); });
  vi.stubGlobal("requestAnimationFrame", frame);
  try {
    const { viewport, scroll, state } = fixture();
    scroll.reconcile(); expect(viewport.top).toBe(800);
    viewport.scrollHeight = 1100;
    scroll.reconcile(); expect(viewport.top).toBe(900);
    expect(state()).toEqual({ following: true, atBottom: true });
    expect(frame).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
test("the dialog can mount hidden before it gets its real viewport", () => {
  const { viewport, scroll } = fixture();
  viewport.clientHeight = 0;
  scroll.reconcile(); expect(viewport.writes).toBe(0);
  viewport.clientHeight = 200;
  scroll.reconcile(); expect(viewport.top).toBe(800);
});
test("latest never reports success until the requested scroll actually happened", () => {
  const { viewport, scroll, state } = fixture();
  viewport.blockWrites = true;
  scroll.latest();
  expect(state()).toEqual({ following: true, atBottom: false });
  expect(viewport.top).toBe(0);
  viewport.blockWrites = false;
  scroll.reconcile(); // visibility/focus or settled layout
  expect(state()).toEqual({ following: true, atBottom: true });
  expect(viewport.top).toBe(800);
});
test("layout scroll events and same-height row replacements cannot impersonate user input", () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile();
  viewport.top = 620; // browser anchoring/clamping, without a wheel or key gesture
  scroll.scrolled();
  expect(viewport.top).toBe(800);
  expect(state().following).toBe(true);
  viewport.scrollHeight = 600;
  scroll.reconcile(); expect(viewport.top).toBe(400);
  viewport.scrollHeight = 1300;
  scroll.reconcile(); expect(viewport.top).toBe(1100);
});
test("upward intent pauses before native scrolling, even if a no-op scroll arrives first", () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile();
  scroll.manual("up"); scroll.scrolled();
  expect(state().following).toBe(false);
  viewport.top = 700; scroll.scrolled();
  viewport.scrollHeight = 1400; scroll.reconcile();
  expect(viewport.top).toBe(700);
  expect(state()).toEqual({ following: false, atBottom: false });
  scroll.reconcile(); // returning focus must preserve the reader's history position
  expect(viewport.top).toBe(700);
});
test("only a real return to the end or Latest resumes the paused reader", () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile(); scroll.manual("up");
  viewport.top = 500; scroll.scrolled();
  viewport.clientHeight = 500; // layout alone now puts the paused position at the end
  scroll.reconcile();
  expect(state()).toEqual({ following: false, atBottom: true });
  scroll.manual("down");
  expect(state().following).toBe(true);
  viewport.scrollHeight = 1500; scroll.reconcile();
  expect(viewport.top).toBe(1000);
  scroll.manual("unknown"); viewport.top = 800; scroll.scrolled();
  viewport.top = 1000; scroll.scrolled();
  expect(state().following).toBe(true);
});
test("resize notifications between a downward movement and its scroll event do not lose resume", () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile(); scroll.manual("up"); viewport.top = 500; scroll.scrolled();
  scroll.manual("down"); viewport.top = 800;
  scroll.reconcile(); scroll.scrolled();
  expect(state().following).toBe(true);
});
test("a tiny overflow is still historical position, with only rounding tolerance at the end", () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile(); scroll.manual("up"); viewport.top = 780; scroll.scrolled();
  expect(state().atBottom).toBe(false);
  viewport.top = 799.5; scroll.scrolled();
  expect(state().atBottom).toBe(true);
});
test("Latest restores follow across later updates, and disposal stops all work", () => {
  const { viewport, scroll, state, changed } = fixture();
  scroll.reconcile(); scroll.manual("up"); viewport.top = 100; scroll.scrolled();
  scroll.latest(); expect(viewport.top).toBe(800);
  viewport.scrollHeight = 2000; scroll.reconcile(); expect(viewport.top).toBe(1800);
  expect(state().following).toBe(true);
  scroll.dispose(); const writes = viewport.writes, calls = changed.mock.calls.length;
  viewport.top = 0; scroll.reconcile(); scroll.latest(); scroll.manual("up"); scroll.scrolled();
  expect(viewport.writes).toBe(writes); expect(changed).toHaveBeenCalledTimes(calls);
});
test('gesture end before the native scroll update cannot resume following at a stale bottom position', () => {
  const { viewport, scroll, state } = fixture();
  scroll.reconcile(); expect(viewport.top).toBe(800);
  scroll.manual('unknown'); scroll.manual('up'); scroll.manual('end');
  expect(state()).toEqual({ following: false, atBottom: true });
  viewport.top = 600; scroll.scrolled(); viewport.scrollHeight = 1200; scroll.reconcile();
  expect(viewport.top).toBe(600);
  expect(state()).toEqual({ following: false, atBottom: false });
  viewport.top = 1000; scroll.scrolled();
  expect(state()).toEqual({ following: true, atBottom: true });
  viewport.scrollHeight = 1400; scroll.reconcile(); expect(viewport.top).toBe(1200);
});
