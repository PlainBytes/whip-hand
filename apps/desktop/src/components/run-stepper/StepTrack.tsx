import type { ReactNode } from 'react';

/**
 * One horizontal run of pills. It scrolls sideways rather than wrapping, so
 * where a pill sits — and which group it reads as belonging to — does not
 * depend on the window's width. The workflow lane's nested track does the
 * same (components/workflow-lane/StepTrack.tsx); the two graphs share the
 * convention.
 */
export function StepTrack({ testid, children }: { testid?: string; children: ReactNode }) {
  return (
    <div
      data-testid={testid}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        minWidth: 0,
        // Keeps the scrollbar off the pill outlines.
        paddingBottom: 4,
      }}
    >
      {children}
    </div>
  );
}
