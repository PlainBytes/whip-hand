import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StepSummary } from './StepSummary.tsx';
import type { AgentStep, CommandStep, LoopStep } from '../../../../packages/core/src/types.ts';

const agentStep: AgentStep = {
  kind: 'agent', id: 'execute', runner: 'claude', model: 'sonnet', mode: 'headless',
  writes: true, prompt: 'p', output: 'execute-report.md', inputs: ['plan', 'review'],
};

describe('StepSummary', () => {
  it('shows ordinal, id, kind, reads and writes without any interaction', () => {
    render(<StepSummary step={agentStep} ordinal={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('execute')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByTestId('reads-chip-execute')).toHaveTextContent('reads: plan, review');
    expect(screen.getByTestId('writes-chip-execute')).toHaveTextContent('writes: execute-report.md');
  });

  it('clicking the reads: chip reports the ids it reads', () => {
    const onReadsClick = vi.fn();
    render(<StepSummary step={agentStep} ordinal={3} onReadsClick={onReadsClick} />);
    fireEvent.click(screen.getByTestId('reads-chip-execute'));
    expect(onReadsClick).toHaveBeenCalledWith(['plan', 'review']);
  });

  it('clicking the writes: chip reports this step\'s own id', () => {
    const onWritesClick = vi.fn();
    render(<StepSummary step={agentStep} ordinal={3} onWritesClick={onWritesClick} />);
    fireEvent.click(screen.getByTestId('writes-chip-execute'));
    expect(onWritesClick).toHaveBeenCalledWith('execute');
  });

  it('a command step shows reads: — with its run: line as the summary text', () => {
    const step: CommandStep = { kind: 'command', id: 'stage', run: 'git add -A', inputs: ['plan'], output: 'stage.log' };
    render(<StepSummary step={step} ordinal={1} />);
    expect(screen.getByText('reads: —')).toBeInTheDocument();
    expect(screen.getByText('git add -A')).toBeInTheDocument();
    expect(screen.queryByTestId('reads-chip-stage')).not.toBeInTheDocument();
  });

  it('a command step that lists attachments says so — the one entry that means something there', () => {
    const step: CommandStep = { kind: 'command', id: 'triage', run: 'ls "$WHIPHAND_RUN_DIR/attachments"', inputs: ['attachments'] };
    render(<StepSummary step={step} ordinal={1} />);
    expect(screen.getByText('reads: attachments')).toBeInTheDocument();
  });

  it('a loop shows its until:, not reads/writes chips', () => {
    const step: LoopStep = { kind: 'loop', id: 'fix', until: 'review', steps: [] };
    render(<StepSummary step={step} ordinal={2} />);
    expect(screen.getByText('until review')).toBeInTheDocument();
    expect(screen.queryByTestId('reads-chip-fix')).not.toBeInTheDocument();
  });

  it('badges endsLoop and disabled when asked, and not otherwise', () => {
    const { rerender } = render(<StepSummary step={agentStep} ordinal={3} />);
    expect(screen.queryByText('ends loop')).not.toBeInTheDocument();
    expect(screen.queryByText('disabled')).not.toBeInTheDocument();
    rerender(<StepSummary step={agentStep} ordinal={3} endsLoop disabled />);
    expect(screen.getByText('ends loop')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('showModeAndWrites adds mode and the writes flag, relabelled "edits files"', () => {
    render(<StepSummary step={agentStep} ordinal={3} showModeAndWrites />);
    expect(screen.getByText('headless')).toBeInTheDocument();
    expect(screen.getByText('edits files')).toBeInTheDocument();
  });

  it('omits mode and edits files when showModeAndWrites is not set', () => {
    render(<StepSummary step={agentStep} ordinal={3} />);
    expect(screen.queryByText('headless')).not.toBeInTheDocument();
    expect(screen.queryByText('edits files')).not.toBeInTheDocument();
  });
});
