import { Button, CounterBadge, Tooltip } from '@fluentui/react-components';
import { pagesInGroup, type NavGroup, type PageDef, type PageId } from '../nav.ts';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { useAppStore, waitingJobs } from '../state/store.ts';
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
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 10px', fontSize: 12, color: 'var(--colorNeutralForeground3)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--colorPaletteGreenForeground1)', flexShrink: 0,
          }}
        />
        Remote access on
      </div>
    </Tooltip>
  );
}

export interface SidebarProps {
  page: PageId;
  /** App owns this because the unsaved-edits guard may defer or refuse the move. */
  onSelectPage: (next: PageId) => void;
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
        background: selected ? 'var(--colorNeutralBackground2)' : undefined,
        borderLeft: `2px solid ${selected ? 'var(--colorBrandForeground1)' : 'transparent'}`,
        borderRadius: 4,
      }}
    >
      {def.label}
      {badge > 0 && (
        <CounterBadge
          aria-hidden
          count={badge}
          appearance="filled"
          color={badgeUrgent ? 'danger' : 'informative'}
          style={{ marginLeft: 'auto' }}
        />
      )}
    </Button>
  );
}

export function Sidebar({ page, onSelectPage }: SidebarProps) {
  const capabilities = useCapabilities();
  const workspacePath = useAppStore(state => state.workspacePath);
  const jobs = useAppStore(state => state.jobs);

  // Activity is the one item that counts: live jobs across every workspace,
  // which is precisely what it lists. Turns urgent when one wants an answer.
  const running = Object.values(jobs).filter(j => !j.finished).length;
  const urgent = waitingJobs(jobs).length > 0;

  function group(name: NavGroup) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
        gap: 2,
        borderRight: '1px solid var(--colorNeutralStroke2)',
        padding: 8,
        minWidth: 200,
      }}
    >
      <WorkspaceSwitcher />
      <div style={{ height: 8 }} />
      {group('workspace')}
      {/* Everything below the spacer is app-scoped: it outlives any one workspace. */}
      <div style={{ flex: 1, minHeight: 16 }} />
      <RemoteAccessIndicator />
      {group('app')}
    </nav>
  );
}
