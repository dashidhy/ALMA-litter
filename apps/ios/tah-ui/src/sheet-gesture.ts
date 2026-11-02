// Adopted from Alma Preview; see docs/ios/frontend-integration-notes.md.
export interface DragPoint { x: number; y: number; time: number }
export type DragPhase = "pending" | "dragging" | "ignored";

export function canDragSheet(options: {
  interactive: boolean; selectedText: boolean; header: boolean; scrollOffsets: number[];
}) {
  if (options.interactive) return false;
  if (options.header) return true;
  return !options.selectedText && options.scrollOffsets.every(offset => offset <= 1);
}

/** One gesture owns its direction. Scrolling down to the top does not become
 * dismissal halfway through that same gesture; the next pull may dismiss. */
export class SheetGesture {
  phase: DragPhase;
  offset = 0;
  private samples: DragPoint[];

  constructor(readonly start: DragPoint, readonly height: number, allowed: boolean) {
    this.phase = allowed ? "pending" : "ignored";
    this.samples = [start];
  }

  move(point: DragPoint) {
    if (this.phase === "ignored") return this.phase;
    const dx = point.x - this.start.x;
    const dy = point.y - this.start.y;
    if (this.phase === "pending") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return this.phase;
      if (dy <= 0 || Math.abs(dx) >= dy) {
        this.phase = "ignored";
        return this.phase;
      }
      this.phase = "dragging";
    }
    this.offset = Math.max(0, dy);
    this.samples = this.samples.filter(sample => point.time - sample.time <= 100);
    this.samples.push(point);
    return this.phase;
  }

  finish(point: DragPoint) {
    const moved = Math.max(Math.abs(point.x - this.start.x), Math.abs(point.y - this.start.y)) >= 8;
    if (this.phase !== "dragging") return { handled: false, dismiss: false, suppressClick: moved };
    this.move(point);
    const first = this.samples[0];
    const velocity = point.time > first.time ? (point.y - first.y) / (point.time - first.time) : 0;
    const distanceThreshold = Math.min(120, Math.max(64, this.height * 0.25));
    return {
      handled: true,
      suppressClick: true,
      dismiss: this.offset >= distanceThreshold || (this.offset >= 32 && velocity >= 0.65),
    };
  }
}

export function outsideSheet(x: number, y: number, bounds: { left: number; right: number; top: number; bottom: number }) {
  return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
}
