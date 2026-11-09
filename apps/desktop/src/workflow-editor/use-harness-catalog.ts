import { useCallback, useEffect, useRef } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';
import type { ListModelsResult } from '../shared/protocol.gen.ts';

/**
 * The one place that knows "refresh" means `listModels({ refresh: true })`.
 * Shared by this hook's own `refresh()` and StepRail's "Refresh list" action,
 * which needs the same call but can't use the hook itself — it isn't mounted
 * once per editor, it's mounted once per agent step card.
 */
export function refreshModelCatalog(
  client: AgentClient,
  setModelCatalog: (result: ListModelsResult) => void,
): void {
  client.request('listModels', { refresh: true })
    .then(setModelCatalog)
    .catch((err: unknown) => console.error('listModels refresh failed', err));
}

/**
 * Prefetches what the Runner dropdown and the Model combobox need, once per
 * editor mount: `doctor` (runner ids) and `listModels` (each runner's model
 * list), in parallel, only for whichever of the two the store doesn't
 * already have cached. Both survive a workspace switch (see store.ts), so
 * reopening the editor after the first fetch sends no request at all.
 *
 * Neither request blocks the editor's first render, and neither is retried
 * automatically on failure — a rejection just leaves the relevant store slot
 * `null`, which both fields already treat as "no suggestions, no warnings":
 * exactly today's plain-text behaviour, never a broken-looking field.
 */
export function useHarnessCatalog(workdir?: string): { refresh: () => void } {
  const client = useAgentClient();
  const agentStatus = useAppStore(state => state.agentStatus);
  const modelCatalog = useAppStore(state => state.modelCatalog);
  const setModelCatalog = useAppStore(state => state.setModelCatalog);
  const doctorResult = useAppStore(state => state.doctorResult);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);
  const storeWorkdir = useAppStore(state => state.workspacePath);
  const catalogWorkdir = workdir ?? storeWorkdir;
  const mcpCatalog = useAppStore(state => state.mcpCatalog);
  const setMcpCatalog = useAppStore(state => state.setMcpCatalog);
  const pluginCatalog = useAppStore(state => state.pluginCatalog);
  const setPluginCatalog = useAppStore(state => state.setPluginCatalog);

  // The store holds one workspace's lists and answers can arrive in any order,
  // so only the newest request of each list may commit. Leaving the workspace
  // (or unmounting) supersedes whatever is in flight; the list is null by then,
  // so the next mount asks again.
  const newest = useRef({ mcp: 0, plugins: 0 });
  const fetchMcp = (dir: string, params: { refresh?: true }): void => {
    const id = ++newest.current.mcp;
    client.request('listMcpServers', { workdir: dir, ...params })
      .then(result => { if (newest.current.mcp === id) setMcpCatalog(result); })
      .catch((err: unknown) => console.error('listMcpServers failed', err));
  };
  const fetchPlugins = (dir: string, params: { refresh?: true }): void => {
    const id = ++newest.current.plugins;
    client.request('listPlugins', { workdir: dir, ...params })
      .then(result => { if (newest.current.plugins === id) setPluginCatalog(result); })
      .catch((err: unknown) => console.error('listPlugins failed', err));
  };
  useEffect(() => {
    const requests = newest.current;
    return () => {
      requests.mcp++;
      requests.plugins++;
    };
  }, [client, catalogWorkdir]);

  useEffect(() => {
    if (agentStatus !== 'connected') return;
    if (modelCatalog === null) {
      client.request('listModels', {})
        .then(setModelCatalog)
        .catch((err: unknown) => console.error('listModels failed', err));
    }
    if (doctorResult === null) {
      client.request('doctor', {})
        .then(setDoctorResult)
        .catch((err: unknown) => console.error('doctor failed', err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefetch once per mount/connect; refresh() covers manual re-checks
  }, [client, agentStatus]);

  // The MCP server and plugin lists are per workspace (they take a workdir),
  // so they refetch when the workspace changes, which clears them in the
  // store. A rejection leaves the slot `null`: the pickers fall back to
  // plain name entry, with no error state.
  useEffect(() => {
    if (agentStatus !== 'connected' || catalogWorkdir === null) return;
    if (mcpCatalog === null) fetchMcp(catalogWorkdir, {});
    if (pluginCatalog === null) fetchPlugins(catalogWorkdir, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefetch once per mount/connect/workspace
  }, [client, agentStatus, catalogWorkdir]);

  const refresh = useCallback(() => {
    refreshModelCatalog(client, setModelCatalog);
    if (catalogWorkdir === null) return;
    fetchMcp(catalogWorkdir, { refresh: true });
    fetchPlugins(catalogWorkdir, { refresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchMcp/fetchPlugins only close over these deps and a ref
  }, [client, setModelCatalog, catalogWorkdir, setMcpCatalog, setPluginCatalog]);

  return { refresh };
}
