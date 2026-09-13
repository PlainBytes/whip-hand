/**
 * The placeholder for a pane with nothing in it yet: an icon above a line of
 * text, centred (not top-left) so it reads as the pane's state rather than a
 * stray label.
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
