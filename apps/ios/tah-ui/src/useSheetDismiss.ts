// Adopted from Alma Preview; see docs/ios/frontend-integration-notes.md.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { canDragSheet, SheetGesture } from "./sheet-gesture";
import type { DragPoint } from "./sheet-gesture";

const interactive = "button, input, select, textarea, label, a, [contenteditable=true], [role=slider], [role=switch]";

export function useSheetDismiss(ref: RefObject<HTMLDialogElement | null>, close: () => void) {
  const closeRef = useRef(close);
  const requestRef = useRef<() => void>(() => {});
  useLayoutEffect(() => { closeRef.current = close; }, [close]);

  useEffect(() => {
    const dialog = ref.current;
    const surface = dialog?.querySelector<HTMLElement>(".sheet-surface");
    if (!dialog || !surface) return;
    const owner = dialog.ownerDocument.defaultView;
    if (!owner) return;
    const listeners = new AbortController();
    let alive = true;
    let closing = false;
    let animation: Animation | undefined;
    let gesture: SheetGesture | undefined;
    let pointerID: number | undefined;
    let touchID: number | undefined;
    let offset = 0;
    let suppressClickUntil = 0;

    const renderOffset = (value: number) => {
      offset = value;
      dialog.style.transform = `translate3d(0, ${value}px, 0)`;
      const progress = Math.min(1, value / Math.max(1, dialog.offsetHeight));
      dialog.style.setProperty("--sheet-backdrop-alpha", String(0.53 * (1 - progress)));
    };
    const settle = (dismiss: boolean) => {
      if (closing) return;
      closing = dismiss;
      const destination = dismiss ? dialog.offsetHeight + 24 : 0;
      animation?.cancel();
      const complete = () => {
        if (!alive) return;
        animation = undefined;
        renderOffset(destination);
        delete dialog.dataset.settling;
        if (dismiss) closeRef.current();
      };
      if (typeof dialog.animate !== "function") {
        complete();
      } else {
        const from = `translate3d(0, ${offset}px, 0)`;
        const to = `translate3d(0, ${destination}px, 0)`;
        const duration = dismiss ? 180 : 220;
        dialog.style.setProperty("--sheet-settle-duration", `${duration}ms`);
        dialog.dataset.settling = "true";
        dialog.style.setProperty("--sheet-backdrop-alpha", dismiss ? "0" : "0.53");
        // One continuous motion path; the fade/reposition variant felt like flicker.
        animation = dialog.animate([{ transform: from }, { transform: to }], {
          duration,
          easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards",
        });
        const current = animation;
        void current.finished.then(() => {
          if (animation !== current) return;
          complete();
          current.cancel(); // The final inline transform now owns the position.
        }).catch(() => {}); // Reopening/unmounting cancels the animation.
      }
    };
    const cancel = () => {
      const wasDragging = gesture?.phase === "dragging";
      gesture = undefined;
      pointerID = undefined;
      touchID = undefined;
      if (wasDragging) {
        suppressClickUntil = performance.now() + 350;
        settle(false);
      }
    };
    const eligible = (target: EventTarget | null, headerOnly: boolean) => {
      if (!(target instanceof Element) || !surface.contains(target)) return false;
      const header = Boolean(target.closest("[data-sheet-drag-region]"));
      if (headerOnly && !header) return false;
      const scrollOffsets: number[] = [];
      for (let node: Element | null = target; node && node !== surface; node = node.parentElement) {
        if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1 &&
            /auto|scroll/.test(owner.getComputedStyle(node).overflowY)) scrollOffsets.push(node.scrollTop);
      }
      return canDragSheet({
        interactive: Boolean(target.closest(interactive)), header,
        selectedText: owner.getSelection()?.isCollapsed === false, scrollOffsets,
      });
    };
    const start = (target: EventTarget | null, point: DragPoint, headerOnly: boolean) => {
      if (closing || animation || !eligible(target, headerOnly)) return false;
      gesture = new SheetGesture(point, dialog.offsetHeight, true);
      return true;
    };
    const move = (point: DragPoint) => {
      if (!gesture) return false;
      const phase = gesture.move(point);
      if (phase === "dragging") renderOffset(gesture.offset);
      // Reserve a tiny downward movement before Safari starts overscroll.
      return phase === "dragging" || (phase === "pending" && point.y > gesture.start.y &&
        point.y - gesture.start.y >= Math.abs(point.x - gesture.start.x));
    };
    const end = (point: DragPoint) => {
      const result = gesture?.finish(point);
      if (gesture?.phase === "dragging") renderOffset(gesture.offset);
      gesture = undefined;
      pointerID = undefined;
      touchID = undefined;
      if (result?.suppressClick) suppressClickUntil = performance.now() + 350;
      if (result?.handled) {
        settle(result.dismiss);
      }
    };
    const point = (event: { clientX: number; clientY: number }): DragPoint =>
      ({ x: event.clientX, y: event.clientY, time: performance.now() });

    // Touch handling deliberately uses a non-passive move listener so a pull at
    // scrollTop=0 can become a sheet drag, while normal content scrolling stays native.
    surface.addEventListener("touchstart", event => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0];
      if (start(event.target, point(touch), false)) touchID = touch.identifier;
    }, { passive: true, signal: listeners.signal });
    surface.addEventListener("touchmove", event => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = Array.from(event.touches).find(item => item.identifier === touchID);
      if (!touch) return;
      if (!event.cancelable) { cancel(); return; }
      if (move(point(touch))) event.preventDefault();
    }, { passive: false, signal: listeners.signal });
    surface.addEventListener("touchend", event => {
      const touch = Array.from(event.changedTouches).find(item => item.identifier === touchID);
      if (touch) end(point(touch));
    }, { signal: listeners.signal });
    surface.addEventListener("touchcancel", cancel, { signal: listeners.signal });

    // Pointer capture supports mouse/pen dragging of the header (including the
    // desktop preview). Touch is handled above, never by both paths.
    surface.addEventListener("pointerdown", event => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      if (start(event.target, point(event), true)) {
        pointerID = event.pointerId;
        dialog.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
    }, { signal: listeners.signal });
    dialog.addEventListener("pointermove", event => {
      if (event.pointerId === pointerID) move(point(event));
    }, { signal: listeners.signal });
    dialog.addEventListener("pointerup", event => {
      if (event.pointerId !== pointerID) return;
      end(point(event));
      if (dialog.hasPointerCapture(event.pointerId)) dialog.releasePointerCapture(event.pointerId);
    }, { signal: listeners.signal });
    dialog.addEventListener("pointercancel", event => {
      if (event.pointerId === pointerID) cancel();
    }, { signal: listeners.signal });
    dialog.addEventListener("lostpointercapture", event => {
      if (event.pointerId === pointerID) cancel();
    }, { signal: listeners.signal });
    dialog.addEventListener("click", event => {
      if (event.detail !== 0 && performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true, signal: listeners.signal });
    const visibility = () => { if (dialog.ownerDocument.hidden) cancel(); };
    dialog.ownerDocument.addEventListener("visibilitychange", visibility, { signal: listeners.signal });
    owner.addEventListener("blur", cancel, { signal: listeners.signal });
    requestRef.current = () => { gesture = undefined; settle(true); };
    return () => {
      alive = false;
      listeners.abort();
      animation?.cancel();
      requestRef.current = () => {};
    };
  }, [ref]);

  return useCallback(() => requestRef.current(), []);
}
