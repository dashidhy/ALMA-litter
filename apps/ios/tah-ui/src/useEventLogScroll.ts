// Adopted from the read-only Mac UI; geometry and user-intent semantics retained.
import { useLayoutEffect, useRef, useState } from "react";
import { createEventLogScroller } from "./event-log-scroll";
import { installManualScrollbar } from "./manual-scrollbar";

/** A bounded, non-virtual log needs no animation loop or guessed resize delay. */
export function useEventLogScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createEventLogScroller> | undefined>(undefined);
  const [position, setPosition] = useState({ following: true, atBottom: true });
  useLayoutEffect(() => {
    const viewport = scrollRef.current, content = contentRef.current;
    if (!viewport || !content) return;
    const scroller = createEventLogScroller(viewport, setPosition);
    controller.current = scroller;
    const removeInput = installManualScrollbar(viewport, scroller.manual);
    viewport.addEventListener("scroll", scroller.scrolled, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroller.reconcile);
    observer?.observe(viewport); observer?.observe(content);
    const document = viewport.ownerDocument, owner = document.defaultView;
    const visible = () => { if (!document.hidden) scroller.reconcile(); };
    document.addEventListener("visibilitychange", visible);
    owner?.addEventListener("focus", scroller.reconcile);
    scroller.reconcile();
    return () => {
      scroller.dispose(); controller.current = undefined;
      observer?.disconnect(); removeInput();
      viewport.removeEventListener("scroll", scroller.scrolled);
      document.removeEventListener("visibilitychange", visible);
      owner?.removeEventListener("focus", scroller.reconcile);
    };
  }, []);
  // Includes same-height replacements and changes to earlier events, not only
  // appended rows. DOM writes/read-back happen now, never in a deferred rAF.
  useLayoutEffect(() => { controller.current?.reconcile(); });
  return { scrollRef, contentRef, ...position, latest: () => controller.current?.latest() };
}
