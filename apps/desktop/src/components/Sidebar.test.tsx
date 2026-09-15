import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Sidebar } from './Sidebar.tsx';
import { RunStatusIcon } from './OngoingRuns.tsx';
import { hasInjectedStyle } from '../test/badge-style.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore, type JobState } from '../state/store.ts';
import { pagesInGroup, type PageId } from '../nav.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';
import { EMPTY_APP_STATE } from '../../../../packages/agent/src/app-state.ts';
import { workspaceColorVar } from '../lib/workspace-identity.ts';

const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };

function renderSidebar(page: PageId = 'runs', capabilities?: AppCapabilities) {
  const onSelectPage = vi.fn();
  const onOpenRun = vi.fn();
  const tree = (
    <FluentProvider theme={webLightTheme}>
      <AgentClientProvider client={new AgentClient(new MockTransport())}>
        <Sidebar page={page} onSelectPage={onSelectPage} onOpenRun={onOpenRun} />
      </AgentClientProvider>
    </FluentProvider>
  );
  render(
    capabilities
      ? <CapabilitiesProvider value={capabilities}>{tree}</CapabilitiesProvider>
      : tree,
  );
  return { onSelectPage, onOpenRun };
}

afterEach(() => useAppStore.setState({ workspacePath: null, appState: null, remoteAccess: null, jobs: {} }));

describe('Sidebar', () => {
  it('renders both groups inside one navigation landmark', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const def of [...pagesInGroup('workspace'), ...pagesInGroup('app')]) {
      expect(within(nav).getByRole('button', { name: def.label })).toBeInTheDocument();
    }
  });

  it('enables the workspace group only when a workspace is open', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Files' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Doctor' })).toBeEnabled();
  });

  it('marks the selected page, but never a gated one', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar('workflows');
    expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('badges Activity with live jobs from every workspace', () => {
    const job = (jobId: string, workdir: string, awaiting = false) => ({
      jobId, workdir, finished: false, stepOrder: [], steps: {}, currentExecution: {},
      events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0,
      ptyDataTrimmed: false, ptyExited: false,
      ...(awaiting ? { awaiting: { stepId: 's', reason: 'permission' as const } } : {}),
    });
    useAppStore.setState({
      workspacePath: '/ws/a',
      jobs: { j1: job('j1', '/ws/a'), j2: job('j2', '/ws/b') },
    });
    renderSidebar();
    // The badge itself is aria-hidden, so the count reaches the name instead.
    expect(screen.getByRole('button', { name: 'Activity (2 running)' })).toBeInTheDocument();
  });

  it('paints the Activity badge in the waiting colour at the shared status size when urgent', () => {
    const job = (jobId: string, workdir: string, awaiting = false) => ({
      jobId, workdir, finished: false, stepOrder: [], steps: {}, currentExecution: {},
      events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0,
      ptyDataTrimmed: false, ptyExited: false,
      ...(awaiting ? { awaiting: { stepId: 's', reason: 'permission' as const } } : {}),
    });
    useAppStore.setState({ workspacePath: '/ws/a', jobs: { j1: job('j1', '/ws/a', true) } });
    renderSidebar();
    const badge = screen.getByRole('button', { name: /^Activity/ })
      .querySelector('.fui-CounterBadge') as HTMLElement;
    // Waiting is the yellow warning fill — not `danger` red, which means
    // failed — and the marker is the one shared 24px status size.
    expect(hasInjectedStyle(badge, 'background-color', 'var(--colorPaletteYellowBackground3)')).toBe(true);
    expect(hasInjectedStyle(badge, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(false);
    expect(hasInjectedStyle(badge, 'height', '24px')).toBe(true);
  });

  it('keeps a merely-running Activity count informative, not the waiting colour', () => {
    const job = (jobId: string, workdir: string) => ({
      jobId, workdir, finished: false, stepOrder: [], steps: {}, currentExecution: {},
      events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0,
      ptyDataTrimmed: false, ptyExited: false,
    });
    useAppStore.setState({ workspacePath: '/ws/a', jobs: { j1: job('j1', '/ws/a') } });
    renderSidebar();
    const badge = screen.getByRole('button', { name: /^Activity/ })
      .querySelector('.fui-CounterBadge') as HTMLElement;
    expect(hasInjectedStyle(badge, 'background-color', 'var(--colorPaletteYellowBackground3)')).toBe(false);
  });

  it('shows no badge when nothing is running', () => {
    useAppStore.setState({ workspacePath: '/ws', jobs: {} });
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
  });

  it('does not mark a workspace page current while no workspace is open', () => {
    renderSidebar('runs');
    expect(screen.getByRole('button', { name: 'Runs' })).not.toHaveAttribute('aria-current');
  });

  it('shows nothing about remote access while it is off', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar();
    expect(screen.queryByText(/remote access on/i)).not.toBeInTheDocument();
  });

  it('marks the app persistently while this machine is reachable', () => {
    // Remote access survives a restart once enabled, so a listening port with
    // nothing on screen saying so is exactly the state to avoid.
    useAppStore.setState({
      workspacePath: '/ws',
      remoteAccess: {
        enabled: true, port: 61338, listening: true, error: null,
        clientCount: 2, addresses: ['192.168.1.20'], webRootPresent: true,
      },
    });
    renderSidebar();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText(/remote access on/i)).toBeInTheDocument();
  });

  it('does not mark the app when remote access is enabled but failed to bind', () => {
    useAppStore.setState({
      workspacePath: '/ws',
      remoteAccess: {
        enabled: true, port: 61338, listening: false, error: 'Port 61338 is already in use',
        clientCount: 0, addresses: [], webRootPresent: true,
      },
    });
    renderSidebar();
    expect(screen.queryByText(/remote access on/i)).not.toBeInTheDocument();
  });

  it('omits the Files page where there is no local filesystem', () => {
    useAppStore.setState({ workspacePath: '/ws' });
    renderSidebar('runs', BROWSER_CAPS);

    expect(screen.queryByRole('button', { name: /^Files$/ })).not.toBeInTheDocument();
    // Everything else still reaches the agent over RPC and stays.
    for (const label of ['Runs', 'Workflows', 'Settings', 'Activity', 'Doctor', 'Preferences']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
  });

  describe('Sidebar layout', () => {
    it('keeps the app group out of the middle scroll region', () => {
      useAppStore.setState({ workspacePath: '/ws' });
      renderSidebar();
      const region = screen.getByTestId('sidebar-scroll-region');
      // The workspace pages scroll; Preferences and friends don't — the app
      // group must stay pinned at the bottom of the nav.
      expect(within(region).getByRole('button', { name: 'Runs' })).toBeInTheDocument();
      expect(within(region).queryByRole('button', { name: 'Preferences' })).not.toBeInTheDocument();
      expect(within(region).queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
    });

    it('makes the middle section the only flexible, scrolling part', () => {
      useAppStore.setState({ workspacePath: '/ws' });
      renderSidebar();
      const nav = screen.getByRole('navigation', { name: 'Main' }) as HTMLElement;
      const region = screen.getByTestId('sidebar-scroll-region') as HTMLElement;
      // A nav that can't shrink, or a middle section that can't shrink, lets
      // a tall sidebar push its bottom rows past the window edge again.
      expect(nav.style.minHeight).toBe('0px');
      expect(nav.style.overflow).toBe('hidden');
      expect(region.style.flex).toBe('1 1 0%');
      expect(region.style.minHeight).toBe('0px');
      expect(region.style.overflowY).toBe('auto');
    });
  });

  describe('Ongoing runs', () => {
    // Defaults to a workdir so every row also exercises the workspace dot and
    // its "· basename" suffix; tests about the no-workdir case override it.
    const job = (jobId: string, extra: Partial<JobState> = {}): JobState => ({
      jobId, finished: false, stepOrder: [], steps: {}, currentExecution: {},
      events: [], logTail: [], logRows: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0,
      ptyDataTrimmed: false, ptyExited: false,
      workdir: '/repos/whip-hand',
      ...extra,
    });

    it('renders rows above Activity', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: { j1: job('j1', { runName: 'OAuth support' }) },
      });
      renderSidebar();
      const nav = screen.getByRole('navigation', { name: 'Main' });
      const section = within(nav).getByLabelText('Ongoing runs');
      expect(within(section).getByRole('button', { name: 'OAuth support — running · whip-hand' })).toBeInTheDocument();

      const activity = within(nav).getByRole('button', { name: /^Activity/ });
      // DOCUMENT_POSITION_FOLLOWING on `activity` means `section` comes first.
      expect(section.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders the name of a job known only from a listJobs summary', () => {
      // Regression: a client that attaches mid-run learns the job only
      // through applyJobSummaries, which used to carry no name at all.
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: { j1: job('j1', { runName: undefined, runId: 'run-1' }) },
      });
      useAppStore.getState().applyJobSummaries([{
        jobId: 'j1', workdir: '/repos/whip-hand', runId: 'run-1', name: 'OAuth support',
        status: 'running', pty: null,
      }]);
      renderSidebar();
      const section = screen.getByLabelText('Ongoing runs');
      expect(within(section).getByRole('button', { name: 'OAuth support — running · whip-hand' })).toBeInTheDocument();
    });

    it('sorts a waiting job first and shows the waiting icon', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: {
          running: job('running', { runName: 'Refactor' }),
          waiting: job('waiting', {
            runName: 'Fix login bug',
            awaiting: { stepId: 's', reason: 'permission' as const },
          }),
        },
      });
      renderSidebar();
      const section = screen.getByLabelText('Ongoing runs');
      const buttons = within(section).getAllByRole('button');
      expect(buttons[0]).toHaveAccessibleName('Fix login bug — needs permission · whip-hand');
      expect(buttons[1]).toHaveAccessibleName('Refactor — running · whip-hand');
    });

    it('shows a per-path colour dot, or an equal-size empty slot when the job has no workdir', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: {
          a: job('a', { runName: 'Run A', workdir: '/repos/alpha' }),
          b: job('b', { runName: 'Run B', workdir: '/repos/beta' }),
          c: job('c', { runName: 'Run C', workdir: undefined }),
        },
      });
      renderSidebar();
      const section = screen.getByLabelText('Ongoing runs');
      const buttons = within(section).getAllByRole('button');
      // The leading glyph slot is the first aria-hidden span in the row, ahead
      // of the trailing status icon; the colour dot, when there is one, is
      // the circular span nested inside it.
      const glyphOf = (i: number) => buttons[i].querySelector('span[aria-hidden]') as HTMLElement;
      const dotOf = (i: number) => glyphOf(i).querySelector('span');

      expect(dotOf(0)!.style.background).toBe(`var(${workspaceColorVar('/repos/alpha')})`);
      expect(dotOf(1)!.style.background).toBe(`var(${workspaceColorVar('/repos/beta')})`);
      expect(dotOf(0)!.style.background).not.toBe(dotOf(1)!.style.background);

      // No workdir: no dot, but the slot itself is still the same 20×20
      // footprint, so the name below still lines up on the label column.
      expect(dotOf(2)).toBeNull();
      expect(glyphOf(2).style.width).toBe('20px');
      expect(glyphOf(2).style.height).toBe('20px');
    });

    it('collapses more than 5 jobs into a "+N more" row', () => {
      const jobs = Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [`j${i}`, job(`j${i}`, { runName: `Run ${i}` })]),
      );
      useAppStore.setState({ workspacePath: '/ws', jobs });
      renderSidebar();
      const section = screen.getByLabelText('Ongoing runs');
      expect(within(section).getAllByRole('button')).toHaveLength(6);
      expect(within(section).getByRole('button', { name: '+2 more' })).toBeInTheDocument();
    });

    it('clicking "+N more" opens Activity', () => {
      const jobs = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`j${i}`, job(`j${i}`, { runName: `Run ${i}` })]),
      );
      useAppStore.setState({ workspacePath: '/ws', jobs });
      const { onSelectPage } = renderSidebar();
      const section = screen.getByLabelText('Ongoing runs');
      fireEvent.click(within(section).getByRole('button', { name: '+1 more' }));
      expect(onSelectPage).toHaveBeenCalledWith('activity');
    });

    it('vanishes when the preference is off', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: { j1: job('j1', { runName: 'OAuth support' }) },
        appState: { ...EMPTY_APP_STATE, showOngoingRuns: false },
      });
      renderSidebar();
      expect(screen.queryByLabelText('Ongoing runs')).not.toBeInTheDocument();
    });

    it('clicking a row calls onOpenRun with the right job', () => {
      const target = job('j1', { runName: 'OAuth support' });
      useAppStore.setState({ workspacePath: '/ws', jobs: { j1: target } });
      const { onOpenRun } = renderSidebar();
      fireEvent.click(screen.getByRole('button', { name: 'OAuth support — running · whip-hand' }));
      expect(onOpenRun).toHaveBeenCalledWith(target);
    });

    // The regression guard for the sidebar rail: every row built on
    // `SIDEBAR_ROW_STYLE` reports the same leading-glyph width and
    // `paddingLeft`, so a future change to any one of them can't drift
    // without this test catching it. `NavItem` spreads the same style in,
    // so its vertical padding and min-height are checked separately below.
    it('keeps every SIDEBAR_ROW_STYLE row on the same rail', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [`j${i}`, job(`j${i}`, { runName: `Run ${i}` })]),
        ),
        remoteAccess: {
          enabled: true, port: 61338, listening: true, error: null,
          clientCount: 1, addresses: ['192.168.1.20'], webRootPresent: true,
        },
      });
      renderSidebar();
      const nav = screen.getByRole('navigation', { name: 'Main' });
      const runsSection = within(nav).getByLabelText('Ongoing runs');

      const workspaceButton = within(nav).getAllByRole('button')[0];
      const runRowButton = within(runsSection).getByRole('button', { name: /Run 0/ });
      const moreRowButton = within(runsSection).getByRole('button', { name: '+1 more' });
      const remoteRow = within(nav).getByText(/remote access on/i).closest('div') as HTMLElement;

      const rows = [workspaceButton, runRowButton, moreRowButton, remoteRow];
      const glyphWidths = rows.map(r => (r.querySelector('span[aria-hidden]') as HTMLElement).style.width);
      const paddingLefts = rows.map(r => r.style.paddingLeft);

      expect(glyphWidths).toEqual(['20px', '20px', '20px', '20px']);
      expect(paddingLefts).toEqual(['12px', '12px', '12px', '12px']);
    });

    // The 24px status markers only fit the 32px rail because every row — nav
    // items included — trims its vertical padding to 3px. A nav item that
    // keeps Fluent's own 5px would grow to 36px while its neighbours stayed
    // 32px, so the rail's vertical geometry is asserted across both kinds.
    it('keeps nav items and the other sidebar rows at the same vertical padding and height', () => {
      useAppStore.setState({
        workspacePath: '/ws',
        jobs: { j1: job('j1', { runName: 'Run 0' }) },
        remoteAccess: {
          enabled: true, port: 61338, listening: true, error: null,
          clientCount: 1, addresses: ['192.168.1.20'], webRootPresent: true,
        },
      });
      renderSidebar();
      const nav = screen.getByRole('navigation', { name: 'Main' });

      const navButton = within(nav).getByRole('button', { name: /^Activity/ });
      const runRowButton = within(nav).getByRole('button', { name: /Run 0/ });
      const remoteRow = within(nav).getByText(/remote access on/i).closest('div') as HTMLElement;

      for (const row of [navButton, runRowButton, remoteRow]) {
        expect(row.style.padding).toBe('3px 12px');
        expect(row.style.minHeight).toBe('32px');
      }
    });
  });

  describe('RunStatusIcon', () => {
    it('renders a spinner for running, a yellow pause badge for waiting, and a red badge for failed', () => {
      // `failed` is unreachable from the live sidebar list today (see OngoingRuns.tsx),
      // so this is the only place its branch gets exercised.
      const { rerender } = render(<RunStatusIcon status="running" />);
      expect(screen.getByRole('progressbar')).toBeInTheDocument();

      // Waiting and failed are real filled badges at the shared 24px status
      // size — the fill and the pause/dismiss symbol inside it come from the
      // badge itself, so they can't drift apart the way hand-coloured icons
      // used to.
      rerender(<RunStatusIcon status="waiting" />);
      const waiting = document.querySelector('.fui-Badge') as HTMLElement;
      expect(waiting).not.toBeNull();
      expect(hasInjectedStyle(waiting, 'background-color', 'var(--colorPaletteYellowBackground3)')).toBe(true);
      expect(hasInjectedStyle(waiting, 'color', 'var(--colorNeutralForeground1Static)')).toBe(true);
      expect(hasInjectedStyle(waiting, 'height', '24px')).toBe(true);

      rerender(<RunStatusIcon status="failed" />);
      const failed = document.querySelector('.fui-Badge') as HTMLElement;
      expect(failed).not.toBeNull();
      expect(hasInjectedStyle(failed, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(true);
      expect(hasInjectedStyle(failed, 'height', '24px')).toBe(true);
    });
  });
});
