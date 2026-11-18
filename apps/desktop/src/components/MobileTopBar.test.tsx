import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MobileTopBar } from './MobileTopBar.tsx';
import { useAppStore, type JobState } from '../state/store.ts';

const job = (id: string, extra: Partial<JobState> = {}): JobState => ({
  jobId: id, workdir: '/ws', runId: id, runName: id, finished: false,
  stepOrder: [], steps: {}, currentExecution: {}, events: [], logTail: [], logRows: [], activityTail: [],
  hasNarrated: false, ptyActive: false, ptyDataBuffer: [], ptyDataBaseIndex: 0, ptyDataTrimmed: false, ptyExited: false,
  ...extra,
});

describe('MobileTopBar', () => {
  afterEach(() => { cleanup(); useAppStore.setState({ jobs: {} }); });

  it('shows the current page label and opens navigation', () => {
    const onOpen = vi.fn();
    render(<MobileTopBar page="doctor" onOpenNavigation={onOpen} />);
    expect(screen.getByText('Doctor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('counts unfinished jobs like the Activity badge, and hides at zero', () => {
    const { rerender } = render(<MobileTopBar page="runs" onOpenNavigation={() => {}} />);
    expect(screen.queryByTestId('mobile-activity-count')).not.toBeInTheDocument();
    useAppStore.setState({ jobs: { a: job('a'), b: job('b'), c: job('c', { finished: true }) } });
    rerender(<MobileTopBar page="runs" onOpenNavigation={() => {}} />);
    expect(screen.getByTestId('mobile-activity-count')).toHaveTextContent('2');
  });
});
