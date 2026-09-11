import type { ReactNode } from 'react';
import { SCROLLPORT_PADDING } from './PageHeader.tsx';

/**
 * Sticky page-level footer (main action buttons). See PageHeader.tsx for
 * why it sticks past the scrollport padding (otherwise content scrolls
 * visibly through the band below it) and why it carries no margin. Buttons
 * placed here follow the verb -> icon convention documented above
 * PageHeader's component definition.
 */
export function PageFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: -SCROLLPORT_PADDING,
        zIndex: 2,
        background: 'var(--colorNeutralBackground1)',
        borderTop: '1px solid var(--colorNeutralStroke2)',
        paddingTop: 12,
        paddingBottom: SCROLLPORT_PADDING + 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}
