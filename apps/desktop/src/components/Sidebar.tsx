import { Button, CounterBadge, Tooltip, type CounterBadgeProps } from '@fluentui/react-components';
import { pagesInGroup, type NavGroup, type PageDef, type PageId } from '../nav.ts';
import { PanelLeftContractRegular, PanelLeftExpandRegular } from '@fluentui/react-icons';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { OngoingRuns, sameOngoingRows } from './OngoingRuns.tsx';
import {
  RowGlyph, RowTrailing, SIDEBAR_GROUP_GAP, SIDEBAR_RAIL_ROW_STYLE, SIDEBAR_ROW_GAP, SIDEBAR_ROW_STYLE,
  SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_EXPANDED,
} from './sidebar-row.tsx';
import { WAITING_BADGE_COLOR, STATUS_BADGE_SIZE } from '../lib/status-style.ts';
import { useAppStore, ongoingJobs, waitingJobs, type JobState } from '../state/store.ts';
import { useAppStoreStable } from '../state/use-stable-selector.ts';
import { useCapabilities } from '../capabilities.tsx';
import { IS_MAC } from '../lib/tab-shortcuts.ts';

/** Fluent's CounterBadge restricts `color` in its types only — see NavItem. */
type CounterBadgeColor = CounterBadgeProps['color'];

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
function RemoteAccessIndicator({ collapsed }: { collapsed: boolean }) {
  const remote = useAppStore(state => state.remoteAccess);
  if (!remote?.listening) return null;
  const devices = remote.clientCount === 1 ? '1 device connected' : `${remote.clientCount} devices connected`;
  return (
    <Tooltip
      content={`Reachable at port ${remote.port} on this network — ${devices}`}
      relationship="description"
    >
      <div
        role={collapsed ? 'img' : undefined}
        aria-label={collapsed ? 'Remote access on' : undefined}
        style={{
          ...SIDEBAR_ROW_STYLE,
          ...(collapsed ? SIDEBAR_RAIL_ROW_STYLE : null),
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
        {!collapsed && 'Remote access on'}
      </div>
    </Tooltip>
  );
}

export { SIDEBAR_WIDTH_COLLAPSED, SIDEBAR_WIDTH_EXPANDED };

export interface SidebarProps {
  page: PageId;
  /** App owns this because the unsaved-edits guard may defer or refuse the move. */
  onSelectPage: (next: PageId) => void;
  /** App owns this too: opening a run from another workspace goes through the same guard. */
  onOpenRun: (job: JobState) => void;
  /** Render the narrow icon rail instead of the full sidebar. */
  collapsed?: boolean;
  /** When given, a toggle row ends the nav; App owns persisting the choice. */
  onToggleCollapsed?: () => void;
}

function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <Tooltip content={`${label} (${IS_MAC ? 'Cmd' : 'Ctrl'}+B)`} relationship="description" positioning="after">
      <Button
        appearance="subtle"
        icon={collapsed ? <PanelLeftExpandRegular /> : <PanelLeftContractRegular />}
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={onToggle}
        style={{
          ...SIDEBAR_ROW_STYLE,
          ...(collapsed ? SIDEBAR_RAIL_ROW_STYLE : null),
          width: '100%',
        }}
      >
        {collapsed ? undefined : label}
      </Button>
    </Tooltip>
  );
}

function NavItem({ def, selected, disabled, collapsed, badge, badgeUrgent, onSelect }: {
  def: PageDef;
  selected: boolean;
  disabled: boolean;
  /** Icon only, with the label in a tooltip and the count as a corner dot. */
  collapsed: boolean;
  /** Live count shown beside the label; 0 renders nothing. */
  badge: number;
  /** True when at least one of those is blocked on this human. */
  badgeUrgent: boolean;
  onSelect: () => void;
}) {
  // The badge is aria-hidden, so the count has to reach the name here.
  const name = badge > 0 ? `${def.label} (${badge} running)` : def.label;
  const badgeColor = (badgeUrgent ? WAITING_BADGE_COLOR : 'informative') as CounterBadgeColor;
  // Collapsed passes no children at all: any child, even `false`, makes Fluent
  // treat the button as labelled and add the icon's label-side margin, which
  // pulls the icon off centre.
  const children = collapsed ? undefined : (
    <>
      {def.label}
      {badge > 0 && (
        <RowTrailing>
          <CounterBadge
            aria-hidden
            count={badge}
            appearance="filled"
            size={STATUS_BADGE_SIZE}
            // Fluent's CounterBadge type omits 'warning' from `color`, but
            // the styles are the shared Badge ones — the yellow fill and its
            // dark number render exactly like any other filled warning badge.
            color={badgeColor}
          />
        </RowTrailing>
      )}
    </>
  );
  const button = (
    <Button
      appearance="subtle"
      icon={<def.icon />}
      disabled={disabled}
      aria-current={selected ? 'page' : undefined}
      aria-label={badge > 0 || collapsed ? name : undefined}
      onClick={onSelect}
      // The same rail geometry every other sidebar row spreads in: with the
      // 24px badge in the trailing slot, Fluent's own 5px vertical padding
      // would grow this row to 36px while its neighbours stayed 32px.
      style={{
        ...SIDEBAR_ROW_STYLE,
        ...(collapsed ? SIDEBAR_RAIL_ROW_STYLE : null),
        width: '100%',
        background: selected ? 'var(--colorNeutralBackground2)' : undefined,
      }}
    >
      {children}
    </Button>
  );

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
      {collapsed ? (
        <Tooltip content={name} relationship="label" positioning="after">
          {button}
        </Tooltip>
      ) : button}
      {collapsed && badge > 0 && (
        <span aria-hidden style={{ position: 'absolute', top: 3, right: 3, display: 'flex', pointerEvents: 'none' }}>
          <CounterBadge aria-hidden dot count={badge} appearance="filled" size="small" color={badgeColor} />
        </span>
      )}
    </div>
  );
}

export function Sidebar({ page, onSelectPage, onOpenRun, collapsed = false, onToggleCollapsed }: SidebarProps) {
  const capabilities = useCapabilities();
  const workspacePath = useAppStore(state => state.workspacePath);
  const showOngoingRuns = useAppStore(state => state.appState?.showOngoingRuns ?? true);

  // Activity is the one item that counts: live jobs across every workspace,
  // which is precisely what it lists. Turns urgent when one wants an answer.
  const running = useAppStore(state => Object.values(state.jobs).filter(j => !j.finished).length);
  const urgent = useAppStore(state => waitingJobs(state.jobs).length > 0);
  const ongoing = useAppStoreStable(state => ongoingJobs(state.jobs), sameOngoingRows);
  const remoteListening = useAppStore(state => state.remoteAccess?.listening ?? false);
  // The rail has no room for the list; the Activity badge covers live runs.
  const hasOngoingRuns = !collapsed && showOngoingRuns && ongoing.length > 0;

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
              collapsed={collapsed}
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
        // A tall middle section must shrink here, never push the app group
        // (Preferences, …) past the window's bottom edge.
        minHeight: 0,
        overflow: 'hidden',
        borderRight: '1px solid var(--colorNeutralStroke2)',
        padding: 8,
        width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
        flexShrink: 0,
        boxSizing: 'border-box',
      }}
    >
      <WorkspaceSwitcher compact={collapsed} />
      <div style={{ height: SIDEBAR_GROUP_GAP }} />
      <div
        data-testid="sidebar-scroll-region"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          // Fluent's focus ring draws slightly outside the row; this keeps it
          // visible at the scroll edges while the negative margin keeps rows
          // aligned with the switcher and the app group.
          paddingInline: 2,
          marginInline: -2,
        }}
      >
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
            <RemoteAccessIndicator collapsed={collapsed} />
            <div style={{ height: SIDEBAR_GROUP_GAP }} />
          </>
        )}
      </div>
      {group('app')}
      {onToggleCollapsed && (
        <div style={{ marginTop: SIDEBAR_ROW_GAP }}>
          <CollapseToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
        </div>
      )}
    </nav>
  );
}
