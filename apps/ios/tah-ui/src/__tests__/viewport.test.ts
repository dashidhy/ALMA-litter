import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackViewport, viewportGeometry } from '../viewport';
import type { ViewportSample } from '../viewport';

const full: ViewportSample = { layoutHeight: 844, layoutWidth: 390, visualHeight: 844, offsetTop: 0, scale: 1, editing: false };
const rest = () => viewportGeometry(full);

describe('keyboard viewport geometry', () => {
  it('fits the visual viewport on first focus without subtracting keyboard height twice', () => {
    const result = viewportGeometry({ ...full, visualHeight: 500, editing: true }, rest());
    expect(result).toMatchObject({ height: 500, top: 0, bottom: 344, keyboard: true, restingHeight: 844 });
  });
  it('follows the first opening animation as soon as visible height starts shrinking', () => {
    let result = rest();
    for (const height of [840, 790, 650, 500]) {
      result = viewportGeometry({ ...full, visualHeight: height, editing: true }, result);
      expect(result.height).toBe(height);
      expect(result.keyboard).toBe(true);
    }
  });
  it.each([
    { layout: 500, visual: 500, offset: 100, height: 500, top: 0, bottom: 0 },
    { layout: 500, visual: 844, offset: 0, height: 500, top: 0, bottom: 0 },
    { layout: 600, visual: 480, offset: 80, height: 480, top: 80, bottom: 40 },
    { layout: 844, visual: 500, offset: 120, height: 500, top: 120, bottom: 224 },
    { layout: 844, visual: 500, offset: 500, height: 500, top: 344, bottom: 0 },
  ])('fits native/visual resize $layout/$visual with offset $offset', ({ layout, visual, offset, height, top, bottom }) => {
    const result = viewportGeometry({ ...full, layoutHeight: layout, visualHeight: visual, offsetTop: offset, editing: true }, rest());
    expect(result).toMatchObject({ height, top, bottom, keyboard: true });
    expect(result.top + result.height + result.bottom).toBe(layout);
  });
  it('tracks different third-party keyboard heights without accumulating an inset', () => {
    let result = rest();
    for (const height of [500, 420, 540, 320, 500]) {
      result = viewportGeometry({ ...full, visualHeight: height, editing: true }, result);
      expect(result.height).toBe(height);
      expect(result.restingHeight).toBe(844);
      expect(result.bottom).toBe(844 - height);
    }
  });
  it.each([true, false])('clears stale iOS offset after full height returns, editing=%s', editing => {
    const open = viewportGeometry({ ...full, visualHeight: 500, offsetTop: 180, editing: true }, rest());
    const closing = viewportGeometry({ ...full, visualHeight: 700, offsetTop: 100, editing }, open);
    expect(closing.keyboard).toBe(true);
    const closed = viewportGeometry({ ...full, offsetTop: 180, editing }, closing);
    expect(closed).toMatchObject({ height: 844, top: 0, bottom: 0, keyboard: false });
    const reopened = viewportGeometry({ ...full, visualHeight: 450, offsetTop: 20, editing: true }, closed);
    expect(reopened).toMatchObject({ height: 450, top: 20, bottom: 374, keyboard: true });
  });
  it('does not treat ordinary window resize or rotation as an open keyboard', () => {
    expect(viewportGeometry({ ...full, layoutHeight: 600, visualHeight: 600 }, rest())).toMatchObject({ keyboard: false, restingHeight: 600 });
    const open = viewportGeometry({ ...full, visualHeight: 500, editing: true }, rest());
    expect(viewportGeometry({ ...full, layoutWidth: 844, layoutHeight: 390, visualHeight: 390 }, open)).toMatchObject({ height: 390, keyboard: false, restingHeight: 390, top: 0 });
  });
  it('does not reflow the shell or mark a pinch zoom as a keyboard', () => {
    const initial = rest();
    expect(viewportGeometry({ ...full, visualHeight: 422, offsetTop: 80, scale: 2 }, initial)).toEqual(initial);
  });
  it('ignores unusable visual sizes and negative offsets', () => {
    expect(viewportGeometry({ ...full, visualHeight: 0, offsetTop: Number.NaN }, rest())).toMatchObject({ height: 844, top: 0 });
    expect(viewportGeometry({ ...full, visualHeight: 500, offsetTop: -10, editing: true }, rest())).toMatchObject({ height: 500, top: 0 });
  });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('viewport listener lifecycle', () => {
  function setup(visual = true) {
    vi.useFakeTimers();
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', visual ? viewport : undefined);
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => window.clearTimeout(frame));
    const shell = document.createElement('div');
    const input = document.createElement('textarea');
    input.value = 'SAM v1 — 保留原文'; shell.append(input); document.body.append(shell);
    const stop = trackViewport(shell);
    return { viewport, shell, input, stop };
  }
  it('catches delayed first-focus geometry, scroll offsets, blur/restore and reopen without editing or scrolling', async () => {
    const { viewport, shell, input, stop } = setup();
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const inputEvent = vi.fn(); input.addEventListener('input', inputEvent);
    input.focus();
    await vi.advanceTimersByTimeAsync(32);
    viewport.height = 500; // Deliberately no resize event during first focus animation.
    await vi.advanceTimersByTimeAsync(32);
    expect(shell.style.getPropertyValue('--app-height')).toBe('500px');
    expect(shell.dataset.keyboard).toBe('true');
    viewport.offsetTop = 100; viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);
    expect(shell.style.getPropertyValue('--app-top')).toBe('100px');
    expect(shell.style.getPropertyValue('--app-bottom')).toBe('244px');
    input.blur(); viewport.height = 700; viewport.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(shell.dataset.keyboard).toBe('true');
    viewport.height = 844; // Stale offsetTop remains 100 after dismissal.
    await vi.advanceTimersByTimeAsync(32);
    expect(shell.style.getPropertyValue('--app-top')).toBe('0px');
    expect(shell.style.getPropertyValue('--app-height')).toBe('844px');
    expect(shell.dataset.keyboard).toBe('false');
    input.focus(); viewport.height = 420; viewport.offsetTop = 0;
    await vi.advanceTimersByTimeAsync(32);
    expect(shell.style.getPropertyValue('--app-height')).toBe('420px');
    expect(input.value).toBe('SAM v1 — 保留原文');
    expect(inputEvent).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled(); stop();
  });
  it('handles native layout resize with no VisualViewport API', async () => {
    const { shell, input, stop } = setup(false); input.focus();
    vi.stubGlobal('innerHeight', 500); window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(shell.style.getPropertyValue('--app-height')).toBe('500px');
    expect(shell.style.getPropertyValue('--app-bottom')).toBe('0px');
    expect(shell.dataset.keyboard).toBe('true'); stop();
  });
  it('removes listeners, style state and the bounded animation loop on cleanup', async () => {
    const { viewport, shell, input, stop } = setup();
    const viewportRemove = vi.spyOn(viewport, 'removeEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    input.focus(); expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(cancelFrame).toHaveBeenCalledWith(requestFrame.mock.results.at(-1)!.value);
    expect(viewportRemove.mock.calls.map(c => c[0])).toEqual(['resize', 'scroll']);
    expect(windowRemove.mock.calls.map(c => c[0])).toEqual(['resize', 'orientationchange']);
    expect(documentRemove.mock.calls.map(c => c[0])).toEqual(['focusin', 'focusout']);
    viewport.height = 400; viewport.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(shell.style.cssText).toBe(''); expect(shell.dataset.keyboard).toBeUndefined();
  });
  it('stops focus sampling after the animation window but still responds to keyboard layout changes', async () => {
    const { viewport, shell, input, stop } = setup(); input.focus();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    viewport.height = 450; viewport.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(16);
    expect(shell.style.getPropertyValue('--app-height')).toBe('450px');
    expect(vi.getTimerCount()).toBe(0); stop();
  });
});
