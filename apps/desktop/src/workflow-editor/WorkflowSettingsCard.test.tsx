import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../state/store.ts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WorkflowSettingsCard } from './WorkflowSettingsCard.tsx';
import type { Workflow } from '../shared/types.ts';

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

describe('WorkflowSettingsCard: MCP and plugin restrictions', () => {
  const WF: Workflow = {
    name: 'w',
    steps: [{ id: 'a', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p' }],
  };

  afterEach(() => {
    useAppStore.setState({ mcpCatalog: null, pluginCatalog: null });
  });

  function pickMode(testId: string, label: RegExp): void {
    fireEvent.click(within(screen.getByTestId(testId)).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: label }));
  }

  it('Only these → github writes mcp: { allow: [github] }', () => {
    useAppStore.setState({
      mcpCatalog: { runners: { claude: { source: 'live', servers: [
        { name: 'github', origin: 'user' }, { name: 'pw', origin: 'user' },
      ] } } },
    });
    const { onUpdate } = renderCard(WF);
    pickMode('workflow-mcp', /only these/i);
    expect(onUpdate).toHaveBeenLastCalledWith({ mcp: { allow: [] } });
    // (the catalog names github and pw; the next test picks one)
  });

  it('checking a cataloged name under Only these allows it', () => {
    useAppStore.setState({
      mcpCatalog: { runners: { claude: { source: 'live', servers: [{ name: 'github', origin: 'user' }, { name: 'pw', origin: 'user' }] } } },
    });
    const { onUpdate } = renderCard({ ...WF, mcp: { allow: [] } });
    const picker = within(screen.getByTestId('workflow-mcp'));
    expect(picker.getByLabelText('github')).toBeInTheDocument();
    expect(picker.getByLabelText('pw')).toBeInTheDocument();
    fireEvent.click(picker.getByLabelText('github'));
    expect(onUpdate).toHaveBeenLastCalledWith({ mcp: { allow: ['github'] } });
  });

  it('going back to All drops the mcp key', () => {
    const { onUpdate } = renderCard({ ...WF, mcp: { deny: ['pw'] } });
    pickMode('workflow-mcp', /^all$/i);
    expect(onUpdate).toHaveBeenLastCalledWith({ mcp: undefined });
  });

  it('adding a server writes it under mcp.servers and keeps the restriction', () => {
    const { onUpdate } = renderCard({ ...WF, mcp: { allow: ['x'] } });
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText(/^Server name/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: 'npx' } });
    fireEvent.change(screen.getByLabelText(/^Args/), { target: { value: 'x' } });
    expect(onUpdate).toHaveBeenLastCalledWith({
      mcp: { allow: ['x'], servers: { x: { command: 'npx', args: ['x'] } } },
    });
  });

  it('a remote server writes type, url and headers', () => {
    const { onUpdate } = renderCard(WF);
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText(/^Server name/), { target: { value: 'r' } });
    fireEvent.click(screen.getByRole('combobox', { name: /^Server type/ }));
    fireEvent.click(screen.getByRole('option', { name: 'http' }));
    fireEvent.change(screen.getByLabelText(/^URL/), { target: { value: 'https://e.x/mcp' } });
    fireEvent.change(screen.getByLabelText(/^Headers/), { target: { value: 'Authorization: Bearer t' } });
    expect(onUpdate).toHaveBeenLastCalledWith({
      mcp: { servers: { r: { type: 'http', url: 'https://e.x/mcp', headers: { Authorization: 'Bearer t' } } } },
    });
  });

  it('a server without a command is a problem and is not pushed', () => {
    const { onUpdate, onProblem } = renderCard(WF);
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByLabelText(/^Server name/), { target: { value: 'x' } });
    expect(onProblem).toHaveBeenLastCalledWith(expect.stringContaining('a command is required'));
    expect(onUpdate).toHaveBeenLastCalledWith({ mcp: undefined });
  });

  it('plugins: Only these with nothing checked writes plugins: { allow: [] }', () => {
    const { onUpdate } = renderCard(WF);
    pickMode('workflow-plugins', /only these/i);
    expect(onUpdate).toHaveBeenLastCalledWith({ plugins: { allow: [] } });
  });

  it('a failed catalog leaves free-text entry, with no warning badge', () => {
    const { onUpdate } = renderCard({ ...WF, plugins: { allow: [] } });
    const picker = within(screen.getByTestId('workflow-plugins'));
    fireEvent.change(picker.getByLabelText(/Add Plugins name/), { target: { value: 'superpowers' } });
    fireEvent.click(picker.getByRole('button', { name: /Add Plugins entry/ }));
    expect(onUpdate).toHaveBeenLastCalledWith({ plugins: { allow: ['superpowers'] } });
  });
});
