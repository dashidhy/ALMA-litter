import { useLayoutEffect, useRef } from 'react';
import { trackViewport } from './viewport';

export function useViewport() {
  const shell = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => shell.current ? trackViewport(shell.current) : undefined, []);
  return shell;
}

/** Reserve the card's actual height so the final conversation entry can scroll
 * fully above it, including larger text and the draft-saving caption. */
export function useComposerInset(visible: boolean) {
  const area = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const container = area.current;
    const card = composer.current;
    if (!visible || !container || !card) return;
    const measure = () => container.style.setProperty('--composer-height', `${card.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(card);
    return () => { observer?.disconnect(); container.style.removeProperty('--composer-height'); };
  }, [visible]);
  return { area, composer };
}
