import { Button, CounterBadge, Tooltip } from '@fluentui/react-components';
import { pagesInGroup, type NavGroup, type PageDef, type PageId } from '../nav.ts';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { OngoingRuns } from './OngoingRuns.tsx';
import { RowGlyph, RowTrailing, SIDEBAR_GROUP_GAP, SIDEBAR_ROW_GAP, SIDEBAR_ROW_STYLE } from './sidebar-row.tsx';
import { useAppStore, ongoingJobs, waitingJobs, type JobState } from '../state/store.ts';
import { useCapabilities } from '../capabilities.tsx';

/**
 * A navigation list, not a TabList. Fluent's Tab carries role="tab", which
 * promises a matching tabpanel this app has never had, and its roving
 * tabindex would dead-end at a group boundary once the list is split into
 * workspace-scoped and app-scoped blocks. A plain <nav> of buttons with
 * aria-current says what this actually is.
 */
/**
 * Present only while the remote channel is actually listening. Remote access
 * survives a restart once enabled, so without a persistent marker the machine
 * could be reachable from the network with nothing on screen saying so.
 */
function RemoteAccessIndicator() {
  const remote = useAppStore(state => state.remoteAccess);
  if (!remote?.listening) return null;
  const devices = remote.clientCount === 1 ? '1 device connected' : `${remote.clientCount} devices connected`;
  return (
    <Tooltip
      content={`Reachable at port ${remote.port} on this network — ${devices}`}
      relationship="description"
    >
      <div
        style={{
          ...SIDEBAR_ROW_STYLE,
          display: 'flex', alignItems: 'center',
          fontSize: 14, color: 'var(--colorNeutralForeground3)',
        }}
      >
        <RowGlyph>
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--colorPaletteGreenForeground1)', flexShrink: 0,
            }}
          />
        </RowGlyph>
        Remote access on
      </div>
    </Tooltip>
  );
}

export interface SidebarProps {
  page: PageId;
  /** App owns this because the unsaved-edits guard may defer or refuse the move. */
  onSelectPage: (next: PageId) => void;
  /** App owns this too: opening a run from another workspace goes through the same guard. */
  onOpenRun: (job: JobState) => void;
}

function NavItem({ def, selected, disabled, badge, badgeUrgent, onSelect }: {
  def: PageDef;
  selected: boolean;
  disabled: boolean;
  /** Live count shown beside the label; 0 renders nothing. */
  badge: number;
  /** True when at least one of those is blocked on this human. */
  badgeUrgent: boolean;
  onSelect: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      {selected && (
        // An overlay, not `borderLeft`: a border widens the button's box by
        // 2px, pushing its content 1px right of every other sidebar row —
        // the exact drift this rail is meant to remove. An overlay also
        // can't collide with Fluent's own focus-visible inset shadow the way
        // an `inset` box-shadow would.
        <span
          aria-hidden
          style={{
            position: 'absolute', left: 0, top: 4, bottom: 4, width: 2,
            borderRadius: 1, background: 'var(--colorBrandForeground1)',
          }}
        />
      )}
      <Button
        appearance="subtle"
        icon={<def.icon />}
        disabled={disabled}
        aria-current={selected ? 'page' : undefined}
        // The badge is aria-hidden, so the count has to reach the name here.
        aria-label={badge > 0 ? `${def.label} (${badge} running)` : undefined}
        onClick={onSelect}
        style={{
          justifyContent: 'flex-start',
          width: '100%',
          background: selected ? 'var(--colorNeutralBackground2)' : undefined,
        }}
      >
        {def.label}
        {badge > 0 && (
          <RowTrailing>
            <CounterBadge
              aria-hidden
              count={badge}
              appearance="filled"
              color={badgeUrgent ? 'danger' : 'informative'}
            />
          </RowTrailing>
        )}
      </Button>
    </div>
  );
}

export function Sidebar({ page, onSelectPage, onOpenRun }: SidebarProps) {
  const capabilities = useCapabilities();
  const workspacePath = useAppStore(state => state.workspacePath);
  const jobs = useAppStore(state => state.jobs);
  const showOngoingRuns = useAppStore(state => state.appState?.showOngoingRuns ?? true);

  // Activity is the one item that counts: live jobs across every workspace,
  // which is precisely what it lists. Turns urgent when one wants an answer.
  const running = Object.values(jobs).filter(j => !j.finished).length;
  const urgent = waitingJobs(jobs).length > 0;
  const ongoing = ongoingJobs(jobs);
  const remoteListening = useAppStore(state => state.remoteAccess?.listening ?? false);
  const hasOngoingRuns = showOngoingRuns && ongoing.length > 0;

  function group(name: NavGroup) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: SIDEBAR_ROW_GAP }}>
        {pagesInGroup(name, capabilities).map(def => {
          const gated = def.requiresWorkspace && !workspacePath;
          return (
            <NavItem
              key={def.id}
              def={def}
              // A gated page never paints as selected. Restore can legitimately
              // land on one with no workspace open, and highlighting a page the
              // shell is refusing to show would just be wrong.
              selected={page === def.id && !gated}
              disabled={gated}
              badge={def.id === 'activity' ? running : 0}
              badgeUrgent={urgent}
              onSelect={() => onSelectPage(def.id)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <nav
      aria-label="Main"
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Block separation is stated once via the named spacers below, not
        // silently summed from this gap plus each spacer's own size.
        gap: 0,
        borderRight: '1px solid var(--colorNeutralStroke2)',
        padding: 8,
        width: 220,
        flexShrink: 0,
        boxSizing: 'border-box',
      }}
    >
      <WorkspaceSwitcher />
      <div style={{ height: SIDEBAR_GROUP_GAP }} />
      {group('workspace')}
      {/* Everything below the spacer is app-scoped: it outlives any one workspace. */}
      <div style={{ flex: 1, minHeight: SIDEBAR_GROUP_GAP }} />
      {hasOngoingRuns && (
        <>
          <OngoingRuns jobs={ongoing} onOpenRun={onOpenRun} onShowMore={() => onSelectPage('activity')} />
          <div style={{ height: SIDEBAR_GROUP_GAP }} />
        </>
      )}
      {remoteListening && (
        <>
          <RemoteAccessIndicator />
          <div style={{ height: SIDEBAR_GROUP_GAP }} />
        </>
      )}
      {group('app')}
    </nav>
  );
}
