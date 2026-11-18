import { Button, CounterBadge, Text, type CounterBadgeProps } from '@fluentui/react-components';
import { NavigationRegular } from '@fluentui/react-icons';
import { PAGES, type PageId } from '../nav.ts';
import { STATUS_BADGE_SIZE, WAITING_BADGE_COLOR } from '../lib/status-style.ts';
import { useAppStore, waitingJobs } from '../state/store.ts';

/** The phone layout's replacement for the sidebar's header: menu, current page, live-run count. */
export function MobileTopBar({ page, onOpenNavigation }: { page: PageId; onOpenNavigation: () => void }) {
  // Same numbers as the sidebar's Activity badge.
  const running = useAppStore(state => Object.values(state.jobs).filter(j => !j.finished).length);
  const urgent = useAppStore(state => waitingJobs(state.jobs).length > 0);
  const label = PAGES.find(def => def.id === page)?.label ?? '';
  return (
    <header
      data-testid="mobile-top-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, boxSizing: 'border-box',
        padding: '4px 8px', paddingTop: 'calc(4px + env(safe-area-inset-top))',
        borderBottom: '1px solid var(--colorNeutralStroke2)',
      }}
    >
      <Button appearance="subtle" icon={<NavigationRegular />} aria-label="Open navigation" onClick={onOpenNavigation} />
      <Text weight="semibold" truncate wrap={false} style={{ flex: 1, minWidth: 0 }}>{label}</Text>
      {running > 0 && (
        <CounterBadge
          data-testid="mobile-activity-count"
          aria-label={`${running} running`}
          count={running}
          appearance="filled"
          size={STATUS_BADGE_SIZE}
          color={(urgent ? WAITING_BADGE_COLOR : 'informative') as CounterBadgeProps['color']}
        />
      )}
    </header>
  );
}
