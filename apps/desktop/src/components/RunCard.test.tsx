import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RunCard } from './RunCard.tsx';
import type { RunSummary } from '../agent/client.ts';

const run = (extra: Partial<RunSummary> = {}): RunSummary => ({
  runId: 'r1', runDir: '/ws/.whiphand/runs/r1', status: 'running', workflow: 'demo',
  startedAt: '2026-01-01T00:00:00Z', name: 'My run', ...extra,
} as RunSummary);

describe('RunCard', () => {
  it('is one button named for the run and its status, showing name, workflow and status', () => {
    const onOpen = vi.fn();
    render(<RunCard run={run()} waiting={false} stages={new Map()} onOpen={onOpen} />);
    const card = screen.getByRole('button', { name: 'My run, running' });
    expect(card).toHaveTextContent('My run');
    expect(card).toHaveTextContent('demo');
    expect(card).toHaveTextContent('running');
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reads waiting for a run blocked on the human, and falls back to the id', () => {
    render(<RunCard run={run({ name: undefined })} waiting stages={new Map()} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'r1, waiting' })).toBeInTheDocument();
  });

  it('shows live stage progress over the manifest, markers, and the workspace when given', () => {
    render(
      <RunCard
        run={run({ locked: true, worktree: { path: 'wt', branch: 'b' } })}
        waiting={false}
        stages={new Map([['r1', { index: 3, total: 7 }]])}
        workspace={{ path: '/dev/other' }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('stage 3/7')).toBeInTheDocument();
    expect(screen.getByLabelText('locked')).toBeInTheDocument();
    expect(screen.getByLabelText('worktree')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('keeps row actions outside the card button', () => {
    render(<RunCard run={run()} waiting={false} stages={new Map()} onOpen={() => {}} actions={<button>More</button>} />);
    expect(screen.getByRole('button', { name: 'My run, running' })).not.toContainElement(screen.getByRole('button', { name: 'More' }));
  });
});
