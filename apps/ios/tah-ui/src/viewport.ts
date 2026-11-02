export interface ViewportSample {
  layoutHeight: number;
  layoutWidth: number;
  visualHeight: number;
  offsetTop: number;
  scale: number;
  editing: boolean;
}
export interface ViewportGeometry {
  height: number;
  top: number;
  bottom: number;
  keyboard: boolean;
  restingHeight: number;
  width: number;
}

/** VisualViewport and the native view may BOTH resize. Use their intersection,
 * never subtract an inferred keyboard height from an already resized view. */
export function viewportGeometry(sample: ViewportSample, previous?: ViewportGeometry): ViewportGeometry {
  const layout = Number.isFinite(sample.layoutHeight) && sample.layoutHeight > 0 ? sample.layoutHeight : previous?.height ?? 1;
  // A pinch zoom is not a keyboard transition; preserve the existing CSS layout.
  if (Math.abs(sample.scale - 1) > .05) {
    return previous ?? { height: layout, top: 0, bottom: 0, keyboard: false, restingHeight: layout, width: sample.layoutWidth };
  }
  const visual = Number.isFinite(sample.visualHeight) && sample.visualHeight > 0 ? sample.visualHeight : layout;
  const height = Math.min(layout, visual);
  const widthChanged = previous !== undefined && Math.abs(previous.width - sample.layoutWidth) > 1;
  const restingHeight = previous && !widthChanged ? previous.restingHeight : layout;
  // Keep tracking a closing keyboard after blur, but never retain offsetTop once
  // full height returns (including iOS reports with a stale positive offset).
  const keyboard = (sample.editing || Boolean(previous?.keyboard && !widthChanged)) && restingHeight - height > 2;
  const offset = Number.isFinite(sample.offsetTop) ? sample.offsetTop : 0;
  const top = keyboard ? Math.max(0, Math.min(offset, layout - height)) : 0;
  return { height, top, bottom: Math.max(0, layout - height - top), keyboard, restingHeight: keyboard ? restingHeight : height, width: sample.layoutWidth };
}

function isTextInput(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/** DOM-only geometry subscription. Does not scroll, focus, blur, or edit text. */
export function trackViewport(shell: HTMLElement, win: Window = window): () => void {
  const viewport = win.visualViewport;
  const doc = shell.ownerDocument;
  let geometry: ViewportGeometry | undefined;
  let frame = 0;
  let settleUntil = 0;
  let disposed = false;
  function measure() {
    geometry = viewportGeometry({
      layoutHeight: doc.documentElement.clientHeight || win.innerHeight,
      layoutWidth: doc.documentElement.clientWidth || win.innerWidth,
      visualHeight: viewport?.height ?? win.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
      scale: viewport?.scale ?? 1,
      editing: isTextInput(doc.activeElement),
    }, geometry);
    shell.style.setProperty('--app-height', `${geometry.height}px`);
    shell.style.setProperty('--app-top', `${geometry.top}px`);
    shell.style.setProperty('--app-bottom', `${geometry.bottom}px`);
    shell.dataset.keyboard = String(geometry.keyboard);
  }
  function schedule() {
    if (!disposed && !frame) frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      measure();
      if (win.performance.now() < settleUntil) schedule();
    });
  }
  function focusChanged() {
    // First focus can precede viewport events. Follow the opening/closing
    // animation for a bounded period as well as every subsequent resize/scroll.
    settleUntil = win.performance.now() + 900;
    measure();
    schedule();
  }
  measure();
  viewport?.addEventListener('resize', schedule, { passive: true });
  viewport?.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule, { passive: true });
  win.addEventListener('orientationchange', focusChanged, { passive: true });
  doc.addEventListener('focusin', focusChanged);
  doc.addEventListener('focusout', focusChanged);
  return () => {
    disposed = true;
    win.cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', focusChanged);
    doc.removeEventListener('focusin', focusChanged);
    doc.removeEventListener('focusout', focusChanged);
    shell.style.removeProperty('--app-height');
    shell.style.removeProperty('--app-top');
    shell.style.removeProperty('--app-bottom');
    delete shell.dataset.keyboard;
  };
}
