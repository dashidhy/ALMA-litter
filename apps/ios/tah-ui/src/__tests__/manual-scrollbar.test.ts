import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installManualScrollbar } from "../manual-scrollbar";

class ScrollElement extends EventTarget {
  dataset: Record<string, string> = {};
  scrollHeight = 2000;
  clientHeight = 300;
  offsetWidth = 300;
  clientWidth = 290;
  owner = Object.assign(new EventTarget(), { getComputedStyle: () => ({ getPropertyValue: () => "10px" }) });
  ownerDocument = { defaultView: this.owner };
  getBoundingClientRect() { return { right: 300 }; }
}
function dispatch(target: EventTarget, type: string, fields = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), fields);
  target.dispatchEvent(event);
  return event;
}
let element: ScrollElement;
let dispose: () => void;
beforeEach(() => { vi.useFakeTimers(); element = new ScrollElement(); dispose = installManualScrollbar(element as unknown as HTMLElement); });
afterEach(() => { dispose(); vi.useRealTimers(); });

test("programmatic scrolling never reveals the scrollbar", () => {
  for (let index = 0; index < 20; index++) { dispatch(element, "scroll"); vi.advanceTimersByTime(150); }
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("wheel input reveals briefly; streaming scroll events cannot keep it visible", () => {
  expect(dispatch(element, "wheel", { deltaY: -100 }).defaultPrevented).toBe(false);
  expect(element.dataset.manualScroll).toBe("true");
  vi.advanceTimersByTime(600);
  dispatch(element, "wheel", { deltaY: -25 });
  vi.advanceTimersByTime(600);
  expect(element.dataset.manualScroll).toBe("true");
  dispatch(element, "scroll");
  vi.advanceTimersByTime(300);
  expect(element.dataset.manualScroll).toBeUndefined();
});
test.each(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])("%s reveals the keyboard-scroll indicator without preventing navigation", key => {
  expect(dispatch(element, "keydown", { key }).defaultPrevented).toBe(false);
  expect(element.dataset.manualScroll).toBe("true");
  vi.advanceTimersByTime(900);
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("horizontal gestures, zoom, typing and ordinary clicks do not reveal", () => {
  dispatch(element, "wheel", { deltaY: 0, deltaX: 10 });
  dispatch(element, "wheel", { deltaY: 100, ctrlKey: true });
  dispatch(element, "keydown", { key: "a" });
  dispatch(element, "keydown", { key: "ArrowDown", isComposing: true });
  dispatch(element, "pointerdown", { button: 0, clientX: 100, pointerId: 1 });
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("touch scrolling reveals, but content with no overflow does not", () => {
  dispatch(element, "touchmove");
  expect(element.dataset.manualScroll).toBe("true");
  vi.advanceTimersByTime(900);
  element.scrollHeight = element.clientHeight;
  dispatch(element, "wheel", { deltaY: 40 });
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("scrollbar dragging stays visible until release or window blur", () => {
  dispatch(element, "pointerdown", { button: 0, clientX: 296, pointerId: 1 });
  vi.advanceTimersByTime(5000);
  expect(element.dataset.manualScroll).toBe("true");
  dispatch(element.owner, "pointerup", { pointerId: 1 });
  vi.advanceTimersByTime(900);
  expect(element.dataset.manualScroll).toBeUndefined();
  dispatch(element, "pointerdown", { button: 0, clientX: 296, pointerId: 2 });
  dispatch(element.owner, "blur");
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("unmount/session changes remove both chrome and input listeners", () => {
  dispatch(element, "wheel", { deltaY: 40 });
  dispose();
  expect(element.dataset.manualScroll).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  dispatch(element, "wheel", { deltaY: 40 });
  dispatch(element.owner, "pointerup", { pointerId: 1 });
  expect(element.dataset.manualScroll).toBeUndefined();
});
test("the log receives explicit direction without treating clicks or scroll events as input", () => {
  const intents: string[] = [];
  const remove = installManualScrollbar(element as unknown as HTMLElement, intent => intents.push(intent));
  try {
    dispatch(element, "scroll"); dispatch(element, "pointerdown", { button: 0, clientX: 50, pointerId: 1 });
    expect(intents).toEqual([]);
    dispatch(element, "wheel", { deltaY: -10 }); dispatch(element, "wheel", { deltaY: 10 });
    dispatch(element, "keydown", { key: " ", shiftKey: true }); dispatch(element, "keydown", { key: "End" });
    dispatch(element, "touchstart", { touches: [{ clientY: 100 }] });
    dispatch(element, "touchmove", { touches: [{ clientY: 110 }] });
    dispatch(element, "touchmove", { touches: [{ clientY: 90 }] });
    dispatch(element, "touchend");
    expect(intents).toEqual(["up", "down", "up", "down", "unknown", "up", "down", "end"]);
  } finally { remove(); }
});
test('stationary touch moves never masquerade as downward intent, and cleanup removes touch/pointer observers', () => {
  const intents: string[] = [];
  const remove = installManualScrollbar(element as unknown as HTMLElement, intent => intents.push(intent));
  expect(dispatch(element, 'touchstart', { touches: [{ clientY: 100 }] }).defaultPrevented).toBe(false);
  expect(dispatch(element, 'touchmove', { touches: [{ clientY: 130 }] }).defaultPrevented).toBe(false);
  dispatch(element, 'touchmove', { touches: [{ clientY: 130 }] });
  dispatch(element, 'touchcancel');
  expect(intents).toEqual(['unknown', 'up', 'end']);
  dispatch(element, 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 7, pointerType: 'pen' });
  dispatch(element.owner, 'pointermove', { clientX: 100, clientY: 150, pointerId: 7 });
  expect(intents.slice(-2)).toEqual(['unknown', 'up']);
  remove(); const count = intents.length;
  dispatch(element, 'touchstart', { touches: [{ clientY: 100 }] });
  dispatch(element, 'touchmove', { touches: [{ clientY: 50 }] });
  dispatch(element.owner, 'pointermove', { clientX: 100, clientY: 80, pointerId: 7 });
  dispatch(element.owner, 'pointerup', { pointerId: 7 });
  expect(intents).toHaveLength(count);
});
