import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkflowSettingsCard } from './WorkflowSettingsCard.tsx';
import type { Workflow } from '../../../../packages/core/src/types.ts';

function renderCard(workflow: Workflow) {
  const onUpdate = vi.fn();
  const onProblem = vi.fn();
  render(
    <WorkflowSettingsCard
      workflow={workflow}
      collapsed={false}
      onToggleCollapsed={() => {}}
      onUpdate={onUpdate}
      onProblem={onProblem}
    />,
  );
  return { onUpdate, onProblem };
}

describe('WorkflowSettingsCard: the inputs table', () => {
  it('adding a row twice gives two distinct rows, not one — a bare name-keyed object would collapse them', () => {
    renderCard({ name: 'w', steps: [] });
    fireEvent.click(screen.getByRole('button', { name: /add input/i }));
    fireEvent.click(screen.getByRole('button', { name: /add input/i }));
    expect(screen.getAllByLabelText(/^Name/)).toHaveLength(2);
  });

  it('renaming a row to another row\'s name keeps both rows and flags the duplicate, instead of deleting one', () => {
    const { onProblem } = renderCard({
      name: 'w',
      inputs: { a: { required: true }, b: { required: false } },
      steps: [],
    });
    const names = screen.getAllByLabelText(/^Name/);
    fireEvent.change(names[1], { target: { value: 'a' } });

    expect(screen.getAllByLabelText(/^Name/)).toHaveLength(2); // both rows survive
    // Both the original 'a' row and the renamed row now collide, so both are flagged.
    expect(screen.getAllByText(/already used by another input/i)).toHaveLength(2);
    expect(onProblem).toHaveBeenLastCalledWith(expect.stringContaining('already used by another input'));
  });

  it('a blank name is flagged and blocks the draft from losing the row silently', () => {
    const { onUpdate, onProblem } = renderCard({ name: 'w', steps: [] });
    fireEvent.click(screen.getByRole('button', { name: /add input/i }));
    expect(screen.getByText(/a name is required/i)).toBeInTheDocument();
    expect(onProblem).toHaveBeenLastCalledWith(expect.stringContaining('a name is required'));
    // The invalid row is never pushed into the draft's inputs record.
    expect(onUpdate).toHaveBeenLastCalledWith({ inputs: undefined });
  });

  it('a row with a valid, unique name is pushed into the draft', () => {
    const { onUpdate, onProblem } = renderCard({ name: 'w', steps: [] });
    fireEvent.click(screen.getByRole('button', { name: /add input/i }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'feature' } });
    expect(onProblem).toHaveBeenLastCalledWith(null);
    expect(onUpdate).toHaveBeenLastCalledWith({ inputs: { feature: { required: false } } });
  });

  it('removing a row clears its problem', () => {
    const { onProblem } = renderCard({ name: 'w', steps: [] });
    fireEvent.click(screen.getByRole('button', { name: /add input/i }));
    expect(screen.getByText(/a name is required/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(onProblem).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(/a name is required/i)).not.toBeInTheDocument();
  });
});
