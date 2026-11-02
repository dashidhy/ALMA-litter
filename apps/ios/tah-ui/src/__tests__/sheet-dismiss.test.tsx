import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Sheet } from '../components/Sheet';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function mount() {
  const close = vi.fn();
  await act(async () => root.render(<Sheet title="Settings" close={close}><p>Options</p><input aria-label="Draft" defaultValue="Keep this draft" /></Sheet>));
  const dialog = host.querySelector('dialog')!;
  Object.defineProperty(dialog, 'offsetHeight', { value: 600 });
  dialog.setPointerCapture = vi.fn(); dialog.hasPointerCapture = () => true; dialog.releasePointerCapture = vi.fn();
  return { dialog, close, header: host.querySelector('[data-sheet-drag-region]')!, content: host.querySelector<HTMLElement>('.sheet-content')! };
}
function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  target.dispatchEvent(event);
}
function touch(target: Element, type: string, x: number, y: number) {
  const point = { identifier: 9, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
  target.dispatchEvent(event);
}

it('dismisses by dragging the handle region through the same close callback as the close button', async () => {
  const { dialog, close, header } = await mount();
  await act(async () => { pointer(header, 'pointerdown', 100, 100); pointer(dialog, 'pointermove', 100, 260); pointer(dialog, 'pointerup', 100, 260); });
  expect(close).toHaveBeenCalledTimes(1);
  expect(host.querySelector('input')!.value).toBe('Keep this draft');
});
it('snaps a cancelled drag back without dismissing', async () => {
  const { dialog, close, header } = await mount();
  await act(async () => { pointer(header, 'pointerdown', 100, 100); pointer(dialog, 'pointermove', 100, 150); pointer(dialog, 'pointercancel', 100, 150); });
  expect(close).not.toHaveBeenCalled();
  expect(dialog.style.transform).toBe('translate3d(0, 0px, 0)');
});
it('does not steal a content scroll that began away from the top, but the next top pull dismisses', async () => {
  const { content, close } = await mount();
  content.style.overflowY = 'auto';
  Object.defineProperties(content, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } });
  content.scrollTop = 80;
  const body = content.querySelector('p')!;
  await act(async () => {
    touch(body, 'touchstart', 100, 100); content.scrollTop = 0;
    touch(body, 'touchmove', 100, 260); touch(body, 'touchend', 100, 260);
  });
  expect(close).not.toHaveBeenCalled();
  await act(async () => { touch(body, 'touchstart', 100, 100); touch(body, 'touchmove', 100, 260); touch(body, 'touchend', 100, 260); });
  expect(close).toHaveBeenCalledTimes(1);
});
it('protects input gestures and preserves the close-button fallback', async () => {
  const { close } = await mount(); const input = host.querySelector('input')!;
  await act(async () => { touch(input, 'touchstart', 100, 100); touch(input, 'touchmove', 100, 300); touch(input, 'touchend', 100, 300); });
  expect(close).not.toHaveBeenCalled();
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  expect(close).toHaveBeenCalledTimes(1); expect(input.value).toBe('Keep this draft');
});

function animationProbe(dialog: HTMLDialogElement, reduced = true) {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const cancel = vi.fn();
  const animate = vi.fn().mockReturnValue({ finished, cancel });
  Object.defineProperty(dialog, 'animate', { value: animate, configurable: true });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
  return { animate, cancel, finish };
}
it('keeps continuous slide dismissal with system reduced motion enabled, then closes once', async () => {
  const { dialog, close, header } = await mount(); const probe = animationProbe(dialog);
  await act(async () => { pointer(header, 'pointerdown', 100, 100); pointer(dialog, 'pointermove', 100, 260); pointer(dialog, 'pointerup', 100, 260); });
  const frames = probe.animate.mock.calls[0][0] as Keyframe[];
  expect(frames.every(frame => frame.opacity === undefined)).toBe(true);
  expect(frames[0].transform).not.toBe(frames[1].transform);
  expect(frames[1].transform).toBe('translate3d(0, 624px, 0)');
  expect(dialog.dataset.settling).toBe('true');
  expect(dialog.style.getPropertyValue('--sheet-backdrop-alpha')).toBe('0');
  expect(close).not.toHaveBeenCalled();
  await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); });
  expect(probe.animate).toHaveBeenCalledTimes(1);
  await act(async () => probe.finish());
  expect(close).toHaveBeenCalledTimes(1); expect(probe.cancel).toHaveBeenCalledTimes(1);
  expect(dialog.dataset.settling).toBeUndefined();
});
it('slides a cancelled pull back without hiding the sheet even with reduced motion enabled', async () => {
  const { dialog, close, header } = await mount(); const probe = animationProbe(dialog);
  await act(async () => { pointer(header, 'pointerdown', 100, 100); pointer(dialog, 'pointermove', 100, 150); pointer(dialog, 'pointercancel', 100, 150); });
  const frames = probe.animate.mock.calls[0][0] as Keyframe[];
  expect(frames).toHaveLength(2);
  expect(frames.every(frame => frame.opacity === undefined)).toBe(true);
  expect(frames[0].transform).not.toBe(frames[1].transform);
  expect(frames[1].transform).toBe('translate3d(0, 0px, 0)');
  await act(async () => probe.finish());
  expect(close).not.toHaveBeenCalled(); expect(dialog.style.transform).toBe('translate3d(0, 0px, 0)');
  expect(host.querySelector('input')!.value).toBe('Keep this draft');
});
it('retains travel in normal mode and cancels pending dismissal on unmount', async () => {
  const { dialog, close } = await mount(); const probe = animationProbe(dialog, false);
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click());
  const frames = probe.animate.mock.calls[0][0] as Keyframe[];
  expect(frames[0].transform).not.toBe(frames[1].transform);
  expect(frames[0].opacity).toBeUndefined();
  await act(async () => root.render(null));
  expect(probe.cancel).toHaveBeenCalledTimes(1);
  await act(async () => probe.finish()); expect(close).not.toHaveBeenCalled();
});
