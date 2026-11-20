/**
 * Dialog tweaks for phone width, shared by every confirm/prompt dialog:
 * `<DialogSurface style={surface}>` takes near the full width and scrolls when
 * tall, and `<DialogActions style={actions}>` lets its buttons wrap. On wide
 * layouts both are undefined, so the dialog is exactly what it was.
 */
import type { CSSProperties } from 'react';
import { useNarrowLayout } from './use-narrow-layout.ts';

export interface NarrowDialogStyles {
  surface: CSSProperties | undefined;
  actions: CSSProperties | undefined;
}

const SURFACE: CSSProperties = {
  width: 'calc(100vw - 24px)',
  maxWidth: 'calc(100vw - 24px)',
  maxHeight: 'calc(100dvh - 24px)',
  overflowY: 'auto',
  boxSizing: 'border-box',
};
const ACTIONS: CSSProperties = { flexWrap: 'wrap' };

export function useNarrowDialogStyles(): NarrowDialogStyles {
  const narrow = useNarrowLayout();
  return narrow ? { surface: SURFACE, actions: ACTIONS } : { surface: undefined, actions: undefined };
}
