/**
 * The placeholder for a pane with nothing in it yet: an icon above a line of
 * text, centred in whatever space it is given.
 *
 * Centred rather than tucked into the top-left corner because these panes are
 * large and mostly empty — a lone sentence up in the corner reads as a stray
 * label, while the same sentence in the middle reads as the state of the
 * pane. Both greys are deliberately quiet: this is what you see *before*
 * anything interesting, so it should not compete with the content that
 * replaces it.
 */
import type { ReactNode } from 'react';
import { Text } from '@fluentui/react-components';

export interface EmptyStateProps {
  /**
   * Sized by the caller — 48px reads as an illustration rather than a button.
   * Omitted for a pane that empties and refills while you watch it: an
   * illustration that flashes in and out on every step boundary draws far more
   * attention than the state it describes.
   */
  icon?: ReactNode;
  children: ReactNode;
}

export function EmptyState({ icon, children }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      style={{
        // Fills the pane so "centred" means centred in the pane, not in the
        // text's own box. FilePreview's other early returns deliberately do
        // the opposite (alignSelf: flex-start) — they size to their content.
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        alignSelf: 'stretch',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 16,
        textAlign: 'center',
        color: 'var(--colorNeutralForeground4)',
      }}
    >
      {icon}
      <Text style={{ color: 'var(--colorNeutralForeground3)' }}>{children}</Text>
    </div>
  );
}
