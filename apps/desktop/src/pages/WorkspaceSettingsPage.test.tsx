import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceSettingsPage } from './WorkspaceSettingsPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { WorkspaceConfig } from '../../../../packages/core/src/types.ts';

const RESOLVED: WorkspaceConfig = {
  defaults: { runner: 'claude' },
  on_findings: 'report',
  loop: { max_iterations: 3 },
  artifacts_dir: '.whiphand/runs',
  runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
};

function scriptedConfig(overrides: { project?: Record<string, unknown>; global?: Record<string, unknown>; config?: typeof RESOLVED } = {}) {
  return {
    config: overrides.config ?? RESOLVED,
    global: { config: overrides.global ?? {}, path: '/g/config.yaml', exists: (overrides.global ?? null) !== null },
    project: { config: overrides.project ?? {}, path: '/ws/.whiphand/config.yaml', exists: true },
  };
}

const SCRIPTED_CONFIG = scriptedConfig();

/** A doctor row for something whiphand can actually drive. */
const runnerRow = (id: string) => ({
  id, label: id, group: 'harness' as const, runner: true, optional: false, installed: true, version: '1.0.0',
});
/** A doctor row for anything else: a support tool, or a harness with no adapter. */
const toolRow = (id: string, group: 'harness' | 'support' = 'harness') => ({
  id, label: id, group, runner: false, optional: true, installed: true, version: '1.0.0',
});

// A page that re-fetches configGet after a successful configSet sends two
// requests for the same method in one test — track which sent indices are
// already answered so `respond` resolves the *next* unanswered one, not the
// same one twice.
const answeredIndices = new WeakMap<MockTransport, Set<number>>();

async function respond(transport: MockTransport, method: string, result: unknown) {
  const answered = answeredIndices.get(transport) ?? new Set<number>();
  answeredIndices.set(transport, answered);
  const { index, req } = await waitFor(() => {
    const i = transport.sent.findIndex((line, idx) => {
      if (answered.has(idx)) return false;
      return (JSON.parse(line) as { method: string }).method === method;
    });
    if (i === -1) throw new Error(`${method} not sent yet`);
    return { index: i, req: transport.sentRequest(i) };
  });
  answered.add(index);
  transport.emitLine({ id: req.id, result });
  return req;
}

function renderWorkspaceSettingsPage() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <WorkspaceSettingsPage />
    </AgentClientProvider>,
  );
  return { transport, client };
}

describe('WorkspaceSettingsPage', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', doctorResult: null, config: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, doctorResult: null, config: null, appState: null, restoreDone: false });
  });

  it('renders values from configGet and disables Save until an edit is made', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', [runnerRow('claude'), toolRow('codex')]);

    expect(await screen.findByDisplayValue('.whiphand/runs')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers only real runners in the Runner dropdown, never support tools', async () => {
    // Doctor reports the whole machine now. Picking `git` or `codex` here
    // would write a workflow that fails validateWorkflowRunners at start-up,
    // so the dropdown filters on `.runner` rather than listing every row.
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', [
      runnerRow('claude'),
      toolRow('codex'),
      toolRow('git', 'support'),
    ]);

    const runner = await screen.findByRole('combobox', { name: /runner/i });
    fireEvent.click(runner);

    expect(await screen.findByRole('option', { name: 'claude' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'codex' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'git' })).not.toBeInTheDocument();
  });

  it('sends the edited config via configSet on Save, and re-disables Save after success', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', [runnerRow('claude')]);

    const artifactsDirInput = await screen.findByDisplayValue('.whiphand/runs');
    fireEvent.change(artifactsDirInput, { target: { value: '.whiphand/artifacts' } });

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The spinner swapped into the icon slot while the request is in flight
    // must not perturb the button's accessible name.
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeInTheDocument();

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({
      workdir: '/ws',
      config: {
        defaults: { runner: 'claude' },
        on_findings: 'report',
        loop: { max_iterations: 3 },
        artifacts_dir: '.whiphand/artifacts',
        runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
      },
      // Nothing is pinned: the retention override checkbox is off, so the
      // written layer is a plain diff against the layer beneath.
      explicitKeys: [],
    });

    transport.emitLine({ id: req.id, result: { ok: true } });
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, artifacts_dir: '.whiphand/artifacts' },
      project: { artifacts_dir: '.whiphand/artifacts' },
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('shows a warning that comments in a hand-edited config file are not preserved', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', []);

    expect(await screen.findByText(/comments in a hand-edited config file are not preserved/i)).toBeInTheDocument();
  });

  it('checking the override writes a numeric max_retained on Save and prunes to it', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', []);

    fireEvent.click(await screen.findByRole('checkbox', { name: /override for this workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toMatchObject({ config: { runs: { max_retained: 10 } } });
    transport.emitLine({ id: req.id, result: { ok: true } });
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } },
      project: { runs: { max_retained: 10 } },
    }));

    const pruneReq = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'pruneRuns') throw new Error('pruneRuns not sent yet');
      return parsed;
    });
    expect(pruneReq.params).toEqual({ workdir: '/ws', max: 10 });
  });

  it('pins the override via explicitKeys so it survives a value equal to the global cap', async () => {
    // The failure without this: diffConfigLayer drops a leaf equal to the
    // layer beneath, so nothing is written, the refetch reports no project
    // override, and the checkbox the user just ticked unticks itself — while
    // the workspace quietly keeps following the global cap it opted out of.
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } },
      global: { runs: { max_retained: 10 } },
    }));
    await respond(transport, 'doctor', []);

    const override = await screen.findByRole('checkbox', { name: /override for this workspace/i });
    expect(override).not.toBeChecked();
    fireEvent.click(override);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toMatchObject({
      config: { runs: { max_retained: 10 } },
      explicitKeys: ['runs.max_retained'],
    });
    transport.emitLine({ id: req.id, result: { ok: true } });

    // With the pin honored server-side the project layer now records it, so
    // the box stays ticked.
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } },
      global: { runs: { max_retained: 10 } },
      project: { runs: { max_retained: 10 } },
    }));
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /override for this workspace/i })).toBeChecked();
    });
  });

  it('unchecking the override falls back to what this workspace would inherit, and does not prune when that is "keep everything"', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 10, auto_name: false, max_attachment_mb: 25 } },
      project: { runs: { max_retained: 10 } },
    }));
    await respond(transport, 'doctor', []);

    fireEvent.click(await screen.findByRole('checkbox', { name: /override for this workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toMatchObject({ config: { runs: { max_retained: null } } });
    transport.emitLine({ id: req.id, result: { ok: true } });
    await respond(transport, 'configGet', SCRIPTED_CONFIG);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('pruneRuns');
  });

  it('unchecking the override falls back to a global cap, not "keep everything", when global sets one', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 20, auto_name: false, max_attachment_mb: 25 } },
      global: { runs: { max_retained: 20 } },
      project: { runs: { max_retained: 20 } },
    }));
    await respond(transport, 'doctor', []);

    fireEvent.click(await screen.findByRole('checkbox', { name: /override for this workspace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    // Falls back to the global cap (20), not to null — a global admin cap
    // must still apply once this workspace stops overriding it.
    expect(req.params).toMatchObject({ config: { runs: { max_retained: 20 } } });
  });

  it('leaves the retention override unchecked when only the global layer sets a cap', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 5, auto_name: false, max_attachment_mb: 25 } },
      global: { runs: { max_retained: 5 } },
    }));
    await respond(transport, 'doctor', []);

    const checkbox = await screen.findByRole('checkbox', { name: /override for this workspace/i });
    expect(checkbox).not.toBeChecked();
    // The merged value (5) is not null, so nothing keyed off that value would
    // show the retention number field, but the correct state has no override
    // to edit either — only the (unrelated) max-iterations spinbutton exists.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    expect(await screen.findAllByText(/inherited from global/i)).not.toHaveLength(0);
  });

  it('lets an overridden workspace explicitly keep everything against a global cap', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, runs: { max_retained: 5, auto_name: false, max_attachment_mb: 25 } },
      global: { runs: { max_retained: 5 } },
      project: { runs: { max_retained: 5 } },
    }));
    await respond(transport, 'doctor', []);

    expect(await screen.findByRole('checkbox', { name: /override for this workspace/i })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /keep everything/i }));
    // Only the (unrelated) max-iterations spinbutton remains once "keep
    // everything" hides the retention cap's own number field.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toMatchObject({ config: { runs: { max_retained: null } } });
  });

  it('shows "Inherited from global" for a field the project layer does not override', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', SCRIPTED_CONFIG);
    await respond(transport, 'doctor', []);

    expect(await screen.findAllByText(/inherited from global/i)).not.toHaveLength(0);
  });

  it('offers "Reset to inherited" for a field the project layer overrides, and it clears the override', async () => {
    const { transport } = renderWorkspaceSettingsPage();
    await respond(transport, 'configGet', scriptedConfig({
      config: { ...RESOLVED, artifacts_dir: '.whiphand/custom' },
      project: { artifacts_dir: '.whiphand/custom' },
    }));
    await respond(transport, 'doctor', []);

    expect(await screen.findByDisplayValue('.whiphand/custom')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/reset to inherited/i));

    expect(screen.getByDisplayValue('.whiphand/runs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
