import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAppStore } from '../state/store.ts';
import { useHarnessCatalog } from './use-harness-catalog.ts';

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../agent/agent-context.tsx', () => ({ useAgentClient: () => client }));

interface Pending {
  method: string;
  params: { workdir?: string; refresh?: boolean };
  resolve: (result: unknown) => void;
}

const row = (name: string) => ({ runners: { claude: { source: 'live' as const, servers: [{ name, origin: 'user' as const }] } } });
const plugins = (name: string) => ({ runners: { claude: { source: 'live' as const, plugins: [{ name, origin: 'user' as const, enabled: true }] } } });

describe('useHarnessCatalog: answers that arrive late', () => {
  let pending: Pending[];

  beforeEach(() => {
    pending = [];
    client.request.mockImplementation((method: string, params: Pending['params']) => new Promise(resolve => {
      pending.push({ method, params, resolve });
    }));
    useAppStore.setState({
      agentStatus: 'connected', modelCatalog: {}, doctorResult: [], mcpCatalog: null, pluginCatalog: null,
    });
  });
  afterEach(() => {
    useAppStore.setState({ doctorResult: null, modelCatalog: null, mcpCatalog: null, pluginCatalog: null });
  });

  function mount(workdir: string) {
    return renderHook((props: { workdir: string }) => useHarnessCatalog(props.workdir), {
      initialProps: { workdir },
    });
  }
  function request(method: string, workdir: string, refresh = false): Pending {
    const found = pending.filter(p => p.method === method && p.params.workdir === workdir && (p.params.refresh === true) === refresh).at(-1);
    if (!found) throw new Error(`no ${method} for ${workdir}`);
    return found;
  }
  async function answer(p: Pending, result: unknown): Promise<void> {
    await act(async () => { p.resolve(result); });
  }

  it("workspace A's answers arriving after a switch to B do not overwrite B's lists", async () => {
    const hook = mount('/a');
    const [mcpA, pluginsA] = [request('listMcpServers', '/a'), request('listPlugins', '/a')];
    hook.rerender({ workdir: '/b' });
    await answer(request('listMcpServers', '/b'), row('from-b'));
    await answer(request('listPlugins', '/b'), plugins('from-b'));
    await answer(mcpA, row('from-a'));
    await answer(pluginsA, plugins('from-a'));
    expect(useAppStore.getState().mcpCatalog).toEqual(row('from-b'));
    expect(useAppStore.getState().pluginCatalog).toEqual(plugins('from-b'));
  });

  it("a refresh started in A does not land in B", async () => {
    useAppStore.setState({ mcpCatalog: row('a-cached'), pluginCatalog: plugins('a-cached') });
    const hook = mount('/a');
    act(() => hook.result.current.refresh());
    const refreshA = request('listMcpServers', '/a', true);
    act(() => useAppStore.setState({ mcpCatalog: null, pluginCatalog: null }));
    hook.rerender({ workdir: '/b' });
    await answer(refreshA, row('from-a'));
    expect(useAppStore.getState().mcpCatalog).toBeNull();
    await answer(request('listMcpServers', '/b'), row('from-b'));
    expect(useAppStore.getState().mcpCatalog).toEqual(row('from-b'));
  });

  it('within a workspace an older answer never replaces a newer refresh', async () => {
    const hook = mount('/a');
    const first = request('listMcpServers', '/a');
    act(() => hook.result.current.refresh());
    await answer(request('listMcpServers', '/a', true), row('fresh'));
    await answer(first, row('stale'));
    expect(useAppStore.getState().mcpCatalog).toEqual(row('fresh'));
  });

  it('an answer arriving after the editor closed is dropped, since the workspace may have changed', async () => {
    const hook = mount('/a');
    const first = request('listMcpServers', '/a');
    hook.unmount();
    await answer(first, row('from-a'));
    expect(useAppStore.getState().mcpCatalog).toBeNull();
  });
});
