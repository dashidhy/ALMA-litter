import { useLayoutEffect } from "react";

const idleDelay = 900;
const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
export type ScrollIntent = "up" | "down" | "unknown" | "end";

export function useManualScrollbar(ref: { current: HTMLElement | null }, identity?: string) {
  useLayoutEffect(() => {
    if (ref.current) return installManualScrollbar(ref.current);
  }, [ref, identity]);
}

/** Scroll events cannot distinguish virtualizer adjustments from user input.
 * Reveal chrome from input intent only, without re-rendering the virtual list. */
export function installManualScrollbar(element: HTMLElement, onIntent?: (intent: ScrollIntent) => void) {
  const owner = element.ownerDocument.defaultView;
  if (!owner) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dragging: number | undefined;
  let touchY: number | undefined;
  let contentPointer: { id: number; x: number; y: number } | undefined;
  const hide = () => { clearTimeout(timer); delete element.dataset.manualScroll; };
  const show = () => {
    if (element.scrollHeight <= element.clientHeight) return;
    element.dataset.manualScroll = "true";
    clearTimeout(timer);
    if (dragging === undefined) timer = setTimeout(hide, idleDelay);
  };
  const input = (intent: ScrollIntent) => {
    if (element.scrollHeight <= element.clientHeight) return;
    onIntent?.(intent); show();
  };
  const wheel = (event: WheelEvent) => { if (!event.ctrlKey && event.deltaY !== 0) input(event.deltaY < 0 ? "up" : "down"); };
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches?.[0]?.clientY;
    // Stop following before compositor scrolling/selection can outrun the first
    // main-thread move or scroll notification. Do not capture or cancel input.
    if (touchY !== undefined) onIntent?.("unknown");
  };
  const touch = (event: TouchEvent) => {
    const next = event.touches?.[0]?.clientY;
    if (next !== undefined && next === touchY) return;
    input(next == null || touchY == null ? "unknown" : next > touchY ? "up" : "down");
    touchY = next;
  };
  const touchEnd = () => { touchY = undefined; onIntent?.("end"); };
  const key = (event: KeyboardEvent) => {
    if (event.target === element && !event.defaultPrevented && !event.isComposing && scrollKeys.has(event.key)) {
      input(["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey) ? "up" : "down");
    }
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    // Device automation and some native input paths report finger-like drags
    // as mouse/pen pointers. Descendant text is still inside this scroller.
    if (Number.isFinite(event.clientY)) {
      contentPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      onIntent?.("unknown");
    }
    if (event.target !== element || event.pointerType === "touch") return;
    const bounds = element.getBoundingClientRect();
    const overlayWidth = Number.parseFloat(owner.getComputedStyle(element).getPropertyValue("--manual-scrollbar-width")) || 0;
    const gutter = Math.max(element.offsetWidth - element.clientWidth, overlayWidth);
    if (event.clientX < bounds.right - gutter || event.clientX > bounds.right) return;
    dragging = event.pointerId;
    input("unknown");
  };
  const pointerMove = (event: PointerEvent) => {
    if (!contentPointer || contentPointer.id !== event.pointerId) return;
    const dx = event.clientX - contentPointer.x;
    const dy = event.clientY - contentPointer.y;
    // A stationary event is not downward intent; horizontal selection stays native.
    if (dy === 0 || Math.abs(dy) < Math.abs(dx)) return;
    input(dy > 0 ? "up" : "down");
    contentPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const pointerUp = (event: PointerEvent) => {
    const content = contentPointer?.id === event.pointerId;
    if (content) contentPointer = undefined;
    if (dragging === event.pointerId) { dragging = undefined; onIntent?.("end"); show(); }
    else if (content) onIntent?.("end");
  };
  const blur = () => { dragging = undefined; contentPointer = undefined; touchY = undefined; hide(); };
  element.addEventListener("wheel", wheel, { passive: true });
  element.addEventListener("touchstart", touchStart, { passive: true });
  element.addEventListener("touchmove", touch, { passive: true });
  element.addEventListener("touchend", touchEnd, { passive: true });
  element.addEventListener("touchcancel", touchEnd, { passive: true });
  element.addEventListener("keydown", key);
  element.addEventListener("pointerdown", pointerDown);
  owner.addEventListener("pointermove", pointerMove, { passive: true });
  owner.addEventListener("pointerup", pointerUp);
  owner.addEventListener("pointercancel", pointerUp);
  owner.addEventListener("blur", blur);
  return () => {
    hide();
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("touchstart", touchStart);
    element.removeEventListener("touchmove", touch);
    element.removeEventListener("touchend", touchEnd);
    element.removeEventListener("touchcancel", touchEnd);
    element.removeEventListener("keydown", key);
    element.removeEventListener("pointerdown", pointerDown);
    owner.removeEventListener("pointermove", pointerMove);
    owner.removeEventListener("pointerup", pointerUp);
    owner.removeEventListener("pointercancel", pointerUp);
    owner.removeEventListener("blur", blur);
  };
}
