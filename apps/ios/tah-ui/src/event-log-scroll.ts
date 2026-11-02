import type { ScrollIntent } from "./manual-scrollbar";

type Viewport = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;
export interface EventLogScrollState { following: boolean; atBottom: boolean }

/** Non-virtual event logs have real DOM dimensions at commit time. Keep user
 * intent separate from measured position; neither layout nor an animation
 * callback is allowed to invent an upward user gesture. */
export function createEventLogScroller(viewport: Viewport, changed: (state: EventLogScrollState) => void) {
  let following = true;
  let disposed = false;
  let lastTop = viewport.scrollTop;
  let published: EventLogScrollState = { following: true, atBottom: true };
  const atBottom = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight) - viewport.scrollTop <= 1;
  const publish = () => {
    const next = { following, atBottom: atBottom() };
    if (next.following !== published.following || next.atBottom !== published.atBottom) {
      published = next; changed(next);
    }
  };
  const reconcile = () => {
    // A dialog's children mount before showModal establishes their dimensions.
    // Keep intent until its ResizeObserver/focus notification supplies a viewport.
    if (disposed || viewport.clientHeight <= 0) return;
    const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (following && Math.abs(target - viewport.scrollTop) > 1) viewport.scrollTop = target;
    if (following) lastTop = viewport.scrollTop;
    // Read back the actual position. A requested/blocked write is not success.
    publish();
  };
  return {
    reconcile,
    manual(intent: ScrollIntent) {
      if (disposed || viewport.clientHeight <= 0 || viewport.scrollHeight <= viewport.clientHeight) return;
      if (intent === "up" || intent === "unknown") following = false;
      // Native touch/pointer end can precede the final compositor scroll event.
      // It must not re-arm follow just because scrollTop still reports the tail.
      else if (intent === "down" && atBottom()) following = true;
      lastTop = viewport.scrollTop;
      publish();
    },
    scrolled() {
      if (disposed || viewport.clientHeight <= 0) return;
      // Resume on an actual downward return to the end, not a stray no-op event
      // delivered between an upward input and the browser's default scrolling.
      if (!following && viewport.scrollTop > lastTop && atBottom()) following = true;
      lastTop = viewport.scrollTop;
      reconcile();
    },
    latest() { if (!disposed) { following = true; reconcile(); } },
    dispose() { disposed = true; },
  };
}
