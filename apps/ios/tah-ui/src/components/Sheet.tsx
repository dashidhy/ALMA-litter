import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { PendingCommandStatus } from './PendingCommand';
import { useSheetDismiss } from '../useSheetDismiss';
import { outsideSheet } from '../sheet-gesture';
import './sheet-gesture.css';

export function Sheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const requestClose = useSheetDismiss(ref, close);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('h2')?.focus();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog className="sheet" ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); requestClose(); }}
    onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && event.detail !== 0 &&
        outsideSheet(event.clientX, event.clientY, bounds)) requestClose();
    }}>
    <div className="sheet-surface">
      <div className="sheet-drag-region" data-sheet-drag-region>
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header"><h2 id={id} tabIndex={-1}>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} onClick={requestClose}><Icon name="close" /></button></header>
      </div>
      <PendingCommandStatus />
      <div className="sheet-content">{children}</div>
    </div>
  </dialog>;
}
