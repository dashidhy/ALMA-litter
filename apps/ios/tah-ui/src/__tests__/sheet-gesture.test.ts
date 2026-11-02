import { describe, expect, it } from "vitest";
import { canDragSheet, outsideSheet, SheetGesture } from "../sheet-gesture";

const point = (x: number, y: number, time: number) => ({ x, y, time });
const begin = (allowed = true, height = 700) => new SheetGesture(point(100, 100, 0), height, allowed);

describe("sheet pull gesture", () => {
  it("ignores a tap and sub-threshold movement", () => {
    const gesture = begin();
    expect(gesture.move(point(102, 104, 30))).toBe("pending");
    expect(gesture.finish(point(102, 104, 50))).toEqual({ handled: false, dismiss: false, suppressClick: false });
  });
  it("tracks downward movement and dismisses after sufficient distance", () => {
    const gesture = begin();
    expect(gesture.move(point(104, 230, 400))).toBe("dragging");
    expect(gesture.offset).toBe(130);
    expect(gesture.finish(point(104, 230, 500)).dismiss).toBe(true);
  });
  it("snaps a slow short pull back", () => {
    const gesture = begin();
    gesture.move(point(101, 160, 400));
    expect(gesture.finish(point(101, 160, 500))).toEqual({ handled: true, dismiss: false, suppressClick: true });
  });
  it("allows an intentional downward flick but not tiny jitter", () => {
    const gesture = begin();
    gesture.move(point(100, 150, 50));
    expect(gesture.finish(point(100, 160, 65)).dismiss).toBe(true);
    const jitter = begin();
    jitter.move(point(100, 112, 5));
    expect(jitter.finish(point(100, 115, 10)).dismiss).toBe(false);
  });
  it("does not remember old velocity after the finger stops", () => {
    const gesture = begin();
    gesture.move(point(100, 160, 50));
    expect(gesture.finish(point(100, 160, 300)).dismiss).toBe(false);
  });
  it("does not dismiss when the user reverses back to the starting point", () => {
    const gesture = begin();
    gesture.move(point(100, 240, 150));
    gesture.move(point(100, 140, 250));
    expect(gesture.finish(point(100, 100, 300)).dismiss).toBe(false);
    expect(gesture.offset).toBe(0);
  });
  it("locks out sideways and upward gestures rather than changing ownership", () => {
    for (const first of [point(130, 102, 20), point(100, 80, 20)]) {
      const gesture = begin();
      expect(gesture.move(first)).toBe("ignored");
      expect(gesture.move(point(100, 400, 100))).toBe("ignored");
      expect(gesture.finish(point(100, 400, 110)).dismiss).toBe(false);
    }
  });
  it("keeps an ineligible content scroll ineligible for its full lifetime", () => {
    const gesture = begin(false);
    expect(gesture.move(point(100, 400, 80))).toBe("ignored");
    expect(gesture.finish(point(100, 400, 90)).dismiss).toBe(false);
  });
  it("suppresses the compatibility click after a rejected sideways drag", () => {
    const gesture = begin();
    gesture.move(point(250, 105, 100));
    expect(gesture.finish(point(250, 105, 110))).toEqual({ handled: false, dismiss: false, suppressClick: true });
  });
  it("uses a reachable distance on a short sheet", () => {
    const gesture = begin(true, 240);
    gesture.move(point(100, 170, 400));
    expect(gesture.finish(point(100, 170, 500)).dismiss).toBe(true);
  });
});

describe("sheet gesture ownership", () => {
  const content = { interactive: false, selectedText: false, header: false, scrollOffsets: [0] };
  it("allows content pulls only when all nested scrollers are at the top", () => {
    expect(canDragSheet(content)).toBe(true);
    expect(canDragSheet({ ...content, scrollOffsets: [0, 60] })).toBe(false);
    expect(canDragSheet({ ...content, scrollOffsets: [-5] })).toBe(true);
  });
  it("always protects controls and text selection in content", () => {
    expect(canDragSheet({ ...content, interactive: true })).toBe(false);
    expect(canDragSheet({ ...content, selectedText: true })).toBe(false);
    expect(canDragSheet({ ...content, header: true, interactive: true })).toBe(false);
  });
  it("lets the header dismiss regardless of the content scroll offset", () => {
    expect(canDragSheet({ ...content, header: true, scrollOffsets: [500] })).toBe(true);
  });
  it("does not treat a captured header click as a backdrop click", () => {
    const bounds = { left: 0, right: 390, top: 80, bottom: 844 };
    expect(outsideSheet(195, 92, bounds)).toBe(false);
    expect(outsideSheet(195, 30, bounds)).toBe(true);
  });
});
