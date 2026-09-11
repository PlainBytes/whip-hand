import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { UpdateBanner } from './UpdateBanner.tsx';
import { useAppStore } from '../state/store.ts';
import type { InstallKind, Updater } from '../lib/updater.ts';

const job = (jobId: string, status: 'running' | 'succeeded') => ({
  jobId, workdir: '/ws', status, finished: status !== 'running', stepOrder: [], steps: {}, currentExecution: {},
  events: [], logTail: [], activityTail: [], hasNarrated: false, ptyActive: false, ptyDataBuffer: [],
  ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
});

function fakeUpdater(overrides: Partial<Updater> = {}): Updater {
  return {
    installKind: vi.fn(async (): Promise<InstallKind> => 'deb'),
    check: vi.fn(async () => null),
    openReleasePage: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderBanner(updater: Updater) {
  render(
    <FluentProvider theme={webLightTheme}>
      <UpdateBanner updater={updater} enabled checkDelayMs={0} />
    </FluentProvider>,
  );
}

describe('UpdateBanner', () => {
  it('renders nothing when disabled — tauri dev never nags', () => {
    const updater = fakeUpdater();
    render(<UpdateBanner updater={updater} enabled={false} />);
    expect(updater.check).not.toHaveBeenCalled();
  });

  it('renders nothing after the automatic check finds nothing — no unsolicited "up to date" bar', async () => {
    const updater = fakeUpdater();
    renderBanner(updater);
    await waitFor(() => expect(updater.check).toHaveBeenCalled());
    expect(screen.queryByText('Whiphand is up to date.')).not.toBeInTheDocument();
  });

  it('shows the "up to date" bar for a manual retry, unlike the automatic check before it', async () => {
    const updater = fakeUpdater({
      check: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    renderBanner(updater);
    expect(await screen.findByText('network down')).toBeInTheDocument();

    updater.check = vi.fn(async () => null);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Whiphand is up to date.')).toBeInTheDocument();
  });

  it('surfaces an available update with an install button, once installKind allows it', async () => {
    const updater = fakeUpdater({
      installKind: vi.fn(async (): Promise<InstallKind> => 'appimage'),
      check: vi.fn(async () => ({ version: '0.2.0', install: vi.fn(async () => {}) })),
    });
    renderBanner(updater);
    expect(await screen.findByText(/0\.2\.0 is available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install and restart' })).toBeEnabled();
  });

  it('offers a release-page link instead of an install button on a .deb install', async () => {
    const updater = fakeUpdater({
      installKind: vi.fn(async (): Promise<InstallKind> => 'deb'),
      check: vi.fn(async () => ({ version: '0.2.0', install: vi.fn(async () => {}) })),
    });
    renderBanner(updater);
    expect(await screen.findByText(/0\.2\.0 is available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install and restart' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open release page' })).toBeInTheDocument();
  });

  it('disables the install button while a run is active, without hiding that an update exists', async () => {
    useAppStore.setState({ jobs: { j1: job('j1', 'running') } });
    try {
      const updater = fakeUpdater({
        installKind: vi.fn(async (): Promise<InstallKind> => 'nsis'),
        check: vi.fn(async () => ({ version: '0.2.0', install: vi.fn(async () => {}) })),
      });
      renderBanner(updater);
      const button = await screen.findByRole('button', { name: 'Install and restart' });
      expect(button).toBeDisabled();
      expect(screen.getByText(/0\.2\.0 is available/)).toBeInTheDocument();
    } finally {
      useAppStore.setState({ jobs: {} });
    }
  });

  it('surfaces a check failure with a retry button, rather than failing silently', async () => {
    const updater = fakeUpdater({ check: vi.fn(async () => { throw new Error('network down'); }) });
    renderBanner(updater);
    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
