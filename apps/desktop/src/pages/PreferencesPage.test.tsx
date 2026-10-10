import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreferencesPage } from './PreferencesPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import type { WorkspaceConfig } from '../shared/types.ts';

const DEFAULT_CONFIG: WorkspaceConfig = {
  defaults: { runner: 'claude' }, on_findings: 'report',
  loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
};
const DEFAULT_OVERRIDE_MAX_RETAINED = 10;

function renderPreferences() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <PreferencesPage />
    </AgentClientProvider>,
  );
  return { transport };
}

/**
 * Finds the `occurrence`-th (0-based) request for `method`, counting only that
 * method. Deliberately NOT a raw index into transport.sent: this page mounts
 * children that issue their own unrelated requests, and an absolute index made
 * these helpers answer the wrong configGet the moment one was added.
 */
async function waitForNth(transport: MockTransport, method: string, occurrence: number) {
  return waitFor(() => {
    let seen = 0;
    for (let i = 0; i < transport.sent.length; i++) {
      if ((JSON.parse(transport.sent[i]!) as { method: string }).method !== method) continue;
      if (seen === occurrence) return transport.sentRequest(i);
      seen += 1;
    }
    throw new Error(`${method} #${occurrence} not sent yet`);
  });
}

async function respondToGlobalConfigGet(transport: MockTransport, config = DEFAULT_CONFIG) {
  const req = await waitForNth(transport, 'configGet', 0);
  transport.emitLine({
    id: req.id,
    result: { config, global: { config: {}, path: '/home/u/.config/whiphand/config.yaml', exists: false } },
  });
  return req;
}

/**
 * Answers the *second* configGet — the one the page fires against the open
 * workspace to find out whether that workspace has a retention override of
 * its own before pruning it. `project` is the raw project layer.
 */
async function respondToWorkspaceConfigGet(
  transport: MockTransport, project: Record<string, unknown>,
) {
  const req = await waitForNth(transport, 'configGet', 1);
  transport.emitLine({
    id: req.id,
    result: {
      config: DEFAULT_CONFIG,
      global: { config: {}, path: '/g/config.yaml', exists: false },
      project: { config: project, path: '/ws/.whiphand/config.yaml', exists: true },
    },
  });
  return req;
}

async function waitForRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const parsed = transport.sentRequest(transport.sent.length - 1);
    if (parsed.method !== method) throw new Error(`${method} not sent yet`);
    return parsed;
  });
}

afterEach(() => {
  useAppStore.setState({ workspacePath: null, appState: null, restoreDone: false, config: null });
});

describe('PreferencesPage', () => {
  it('saves the theme via setUiState with no workspace open', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('combobox', { name: /theme/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Dark' }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'setUiState') throw new Error('setUiState not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({ theme: 'dark' });
    expect(useAppStore.getState().appState?.theme).toBe('dark');
  });

  it('shows Visual Studio Code by default and saves a preset editor via setUiState', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    const dropdown = await screen.findByRole('combobox', { name: /editor/i });
    expect(dropdown).toHaveValue('Visual Studio Code');
    fireEvent.click(dropdown);
    fireEvent.click(await screen.findByRole('option', { name: 'Zed' }));

    const req = await waitForRequest(transport, 'setUiState');
    expect(req.params).toEqual({ editor: { kind: 'zed' } });
    expect(useAppStore.getState().appState?.editor).toEqual({ kind: 'zed' });
  });

  it('reveals the command input for a custom editor and sends it on blur or Enter', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    expect(screen.queryByRole('textbox', { name: /editor command/i })).toBeNull();
    fireEvent.click(await screen.findByRole('combobox', { name: /editor/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Custom command…' }));
    const input = await screen.findByRole('textbox', { name: /editor command/i });
    const sentSetUiState = () => transport.sent
      .filter(line => (JSON.parse(line) as { method: string }).method === 'setUiState');

    fireEvent.change(input, { target: { value: '/opt/bin/subl' } });
    fireEvent.blur(input);
    const req = await waitForRequest(transport, 'setUiState');
    expect(req.params).toEqual({ editor: { kind: 'custom', command: '/opt/bin/subl' } });

    fireEvent.change(input, { target: { value: 'code-oss' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sentSetUiState()).toHaveLength(2));
    expect(transport.sentRequest(transport.sent.length - 1).params)
      .toEqual({ editor: { kind: 'custom', command: 'code-oss' } });
  });

  it('never sends a blank custom command', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('combobox', { name: /editor/i }));
    fireEvent.click(await screen.findByRole('option', { name: 'Custom command…' }));
    const input = await screen.findByRole('textbox', { name: /editor command/i });

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('setUiState');
    expect(useAppStore.getState().appState?.editor).toEqual({ kind: 'vscode' });
  });

  it('seeds the command input from a stored custom editor', async () => {
    useAppStore.setState({
      workspacePath: null, restoreDone: true,
      appState: { ...EMPTY_APP_STATE, editor: { kind: 'custom', command: 'subl' } },
    });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    expect(await screen.findByRole('textbox', { name: /editor command/i })).toHaveValue('subl');
    expect(screen.getByRole('combobox', { name: /editor/i })).toHaveValue('Custom command…');
  });

  it('saves the ongoing-runs preference via setUiState', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('checkbox', { name: /show ongoing runs in the sidebar/i }));

    const req = await waitForRequest(transport, 'setUiState');
    expect(req.params).toEqual({ showOngoingRuns: false });
    expect(useAppStore.getState().appState?.showOngoingRuns).toBe(false);
  });

  it('fetches only the global config layer, with no workdir, even with no workspace open', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();

    const req = await respondToGlobalConfigGet(transport);
    expect(req.params).toEqual({});
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('listWorkflows');
    expect(methods).not.toContain('listRuns');
  });

  it('the retention checkbox and spin button read the global runs.max_retained', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport, { ...DEFAULT_CONFIG, runs: { max_retained: 7, auto_name: false, max_attachment_mb: 25 } });

    expect(await screen.findByRole('checkbox', { name: /limit runs kept/i })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: /maximum runs kept per workspace/i })).toHaveValue('7');
  });

  it('changing the spin button writes configSet with scope global', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport, { ...DEFAULT_CONFIG, runs: { max_retained: 7, auto_name: false, max_attachment_mb: 25 } });

    const spin = await screen.findByRole('spinbutton', { name: /maximum runs kept per workspace/i });
    fireEvent.change(spin, { target: { value: '5' } });
    fireEvent.blur(spin);

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({
      config: { ...DEFAULT_CONFIG, runs: { max_retained: 5, auto_name: false, max_attachment_mb: 25 } },
      scope: 'global',
    });
  });

  it('unchecking the limit writes null via configSet with scope global', async () => {
    useAppStore.setState({ workspacePath: null, appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport, { ...DEFAULT_CONFIG, runs: { max_retained: 7, auto_name: false, max_attachment_mb: 25 } });

    fireEvent.click(await screen.findByRole('checkbox', { name: /limit runs kept/i }));

    const req = await waitFor(() => {
      const parsed = transport.sentRequest(transport.sent.length - 1);
      if (parsed.method !== 'configSet') throw new Error('configSet not sent yet');
      return parsed;
    });
    expect(req.params).toEqual({
      config: { ...DEFAULT_CONFIG, runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 } },
      scope: 'global',
    });
  });

  it('prunes the open workspace when its project layer has no override of its own', async () => {
    useAppStore.setState({ workspacePath: '/ws', appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('checkbox', { name: /limit runs kept/i }));

    const setReq = await waitForRequest(transport, 'configSet');
    transport.emitLine({ id: setReq.id, result: { ok: true } });

    // The project layer is read from the agent, not from the store.
    await respondToWorkspaceConfigGet(transport, {});

    const pruneReq = await waitForRequest(transport, 'pruneRuns');
    expect(pruneReq.params).toEqual({ workdir: '/ws', max: DEFAULT_OVERRIDE_MAX_RETAINED });
  });

  it('does not prune the open workspace when its project layer sets its own override', async () => {
    useAppStore.setState({ workspacePath: '/ws', appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('checkbox', { name: /limit runs kept/i }));

    const setReq = await waitForRequest(transport, 'configSet');
    transport.emitLine({ id: setReq.id, result: { ok: true } });
    await respondToWorkspaceConfigGet(transport, { runs: { max_retained: 10 } });

    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: /maximum runs kept per workspace/i })).toHaveValue(
        String(DEFAULT_OVERRIDE_MAX_RETAINED),
      );
    });
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('pruneRuns');
  });

  it('does not prune a workspace that explicitly keeps everything, even with no store config', async () => {
    // The regression this guards: `state.config` is populated only by
    // WorkspaceSettingsPage and cleared on every workspace switch, so from
    // this page it is normally null. Inferring "inherits the global cap" from
    // that null made lowering the global limit delete the run history of a
    // workspace that had explicitly set `runs.max_retained: null` to keep it.
    useAppStore.setState({
      workspacePath: '/ws', appState: EMPTY_APP_STATE, restoreDone: true, config: null,
    });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('checkbox', { name: /limit runs kept/i }));

    const setReq = await waitForRequest(transport, 'configSet');
    transport.emitLine({ id: setReq.id, result: { ok: true } });
    await respondToWorkspaceConfigGet(transport, { runs: { max_retained: null } });

    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: /maximum runs kept per workspace/i })).toHaveValue(
        String(DEFAULT_OVERRIDE_MAX_RETAINED),
      );
    });
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('pruneRuns');
  });

  it('does not prune when the project layer lookup itself fails', async () => {
    // Pruning is irreversible, so an unanswerable "does this workspace opt
    // out?" has to mean "leave it alone", not "assume it doesn't".
    useAppStore.setState({ workspacePath: '/ws', appState: EMPTY_APP_STATE, restoreDone: true });
    const { transport } = renderPreferences();
    await respondToGlobalConfigGet(transport);

    fireEvent.click(await screen.findByRole('checkbox', { name: /limit runs kept/i }));

    const setReq = await waitForRequest(transport, 'configSet');
    transport.emitLine({ id: setReq.id, result: { ok: true } });

    const getReq = await waitFor(() => {
      const index = transport.sent.findIndex((line, i) =>
        i > 0 && (JSON.parse(line) as { method: string }).method === 'configGet');
      if (index === -1) throw new Error('workspace configGet not sent yet');
      return transport.sentRequest(index);
    });
    transport.emitLine({ id: getReq.id, error: { code: -32000, message: 'boom' } });

    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: /maximum runs kept per workspace/i })).toHaveValue(
        String(DEFAULT_OVERRIDE_MAX_RETAINED),
      );
    });
    const methods = transport.sent.map(line => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain('pruneRuns');
  });
});
