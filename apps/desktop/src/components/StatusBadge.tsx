import { Badge } from '@fluentui/react-components';
import { WAITING_BADGE_COLOR } from '../lib/status-style.ts';

const STATUS_COLOR: Record<string, 'brand' | 'success' | 'danger' | 'warning' | 'subtle'> = {
  running: 'brand',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'subtle',
  interrupted: 'warning',
  // Not a run status on disk: the runs list substitutes it for a live run
  // whose session is blocked on the human.
  waiting: WAITING_BADGE_COLOR,
  unknown: 'subtle',
};

/** Shared run/job status pill: consistent colors for RunsPage and RunDetailPage. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge appearance="filled" color={STATUS_COLOR[status] ?? 'subtle'}>
      {status}
    </Badge>
  );
}
