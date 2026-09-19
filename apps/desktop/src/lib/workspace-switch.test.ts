import { afterEach, describe, expect, it } from 'vitest';
import { openWorkspace, settlePendingWorkspaceSwitch } from './workspace-switch.ts';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { useAppStore } from '../state/store.ts';

function setup() {
  const transport = new MockTransport();
  return { transport, client: new AgentClient(transport) };
}

/** Resolves the pending request for `method`, or rejects it when `error` is given. */
async function settleRequest(
  transport: MockTransport, method: string, result: unknown, error?: { code: number; message: string },
): Promise<void> {
  await Promise.resolve();
  const index = transport.sent.findIndex(
    line => (JSON.parse(line) as { method: string }).method === method);
  expect(index).toBeGreaterThanOrEqual(0);
  const req = transport.sentRequest(index);
  transport.emitLine(error ? { id: req.id, error } : { id: req.id, result });
}

afterEach(() => {
  useAppStore.setState({
    workspacePath: null, workspaceIdentityKey: null, filesDirty: false, pendingWorkspaceSwitch: null, appState: null,
  });
});

describe('openWorkspace', () => {
  it('adopts the canonical path the agent returns', async () => {
    const { transport, client } = setup();
    const promise = openWorkspace(client, '/ws/a/');
    await settleRequest(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: '/ws/a', lastOpenedAt: 'now' }],
    });

    expect(await promise).toBe(true);
    expect(useAppStore.getState().workspacePath).toBe('/ws/a');
  });

  it('adopts the identity key the agent returns, so workspace comparisons can use it', async () => {
    const { transport, client } = setup();
    const promise = openWorkspace(client, 'C:\\PROGRA~1\\Proj');
    await settleRequest(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: 'C:\\PROGRA~1\\Proj', identityKey: 'c:/program files/proj', lastOpenedAt: 'now' }],
    });

    await promise;
    expect(useAppStore.getState().workspaceIdentityKey).toBe('c:/program files/proj');
  });

  it('throws when the agent refuses the path', async () => {
    const { transport, client } = setup();
    const promise = openWorkspace(client, '/gone');
    await settleRequest(transport, 'touchRecentWorkspace', null, {
      code: -32000, message: 'not an existing directory: /gone',
    });

    await expect(promise).rejects.toThrow(/not an existing directory/);
  });

  it('asks before discarding unsaved edits, and switches when discard is confirmed', async () => {
    useAppStore.setState({ filesDirty: true, workspacePath: '/ws/a' });
    const { transport, client } = setup();
    const promise = openWorkspace(client, '/ws/b');

    await Promise.resolve();
    expect(useAppStore.getState().pendingWorkspaceSwitch).toBe('/ws/b');
    // Nothing has gone to the agent yet — the guard runs before the switch.
    expect(transport.sent).toHaveLength(0);

    settlePendingWorkspaceSwitch(true);
    await settleRequest(transport, 'touchRecentWorkspace', {
      recentWorkspaces: [{ path: '/ws/b', lastOpenedAt: 'now' }],
    });

    expect(await promise).toBe(true);
    expect(useAppStore.getState().workspacePath).toBe('/ws/b');
    expect(useAppStore.getState().filesDirty).toBe(false);
  });

  it('reports false and changes nothing when the user keeps editing', async () => {
    useAppStore.setState({ filesDirty: true, workspacePath: '/ws/a' });
    const { transport, client } = setup();
    const promise = openWorkspace(client, '/ws/b');

    await Promise.resolve();
    settlePendingWorkspaceSwitch(false);

    expect(await promise).toBe(false);
    expect(useAppStore.getState().workspacePath).toBe('/ws/a');
    expect(useAppStore.getState().filesDirty).toBe(true);
    expect(useAppStore.getState().pendingWorkspaceSwitch).toBeNull();
    expect(transport.sent).toHaveLength(0);
  });

  it('lets a second request supersede the first rather than stacking dialogs', async () => {
    useAppStore.setState({ filesDirty: true, workspacePath: '/ws/a' });
    const { client } = setup();
    const first = openWorkspace(client, '/ws/b');
    await Promise.resolve();
    const second = openWorkspace(client, '/ws/c');
    await Promise.resolve();

    // The newest click is the one the human meant.
    expect(await first).toBe(false);
    expect(useAppStore.getState().pendingWorkspaceSwitch).toBe('/ws/c');

    settlePendingWorkspaceSwitch(false);
    expect(await second).toBe(false);
  });
});
