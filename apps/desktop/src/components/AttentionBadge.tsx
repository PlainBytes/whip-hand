/**
 * "Someone is waiting on you", rendered the one way this app renders it.
 *
 * Warning-coloured and filled, per the house rule that `filled` means a live
 * state (a run's status, a verdict, this) while `tint` means static metadata
 * (a step's kind, `×N`, "Global"). It is deliberately not a StatusBadge: that
 * one falls back to grey, which is the wrong affordance for the single thing
 * on a run's page we actually want noticed.
 *
 * `compact` is the tab form — a bare dot, because a tab label plus a
 * three-word badge is too wide to sit next to its neighbours. The label is
 * still carried, as the dot's accessible name: before this the tab cue was a
 * literal '•' spliced into the label string, which no screen reader could
 * explain.
 */
import { Badge } from '@fluentui/react-components';

export interface AttentionBadgeProps {
  /** Badge register — from AWAIT_LABEL / manualLabel, never written inline. */
  label: string;
  /** Render as a bare dot with `label` as its accessible name. */
  compact?: boolean;
  'data-testid'?: string;
}

export function AttentionBadge({ label, compact, 'data-testid': testId }: AttentionBadgeProps) {
  if (compact) {
    return (
      <Badge
        color="warning"
        appearance="filled"
        size="tiny"
        aria-label={label}
        data-testid={testId}
        style={{ marginInlineStart: 6 }}
      />
    );
  }
  return (
    <Badge color="warning" appearance="filled" data-testid={testId}>
      {label}
    </Badge>
  );
}
