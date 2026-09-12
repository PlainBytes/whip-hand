import { useCallback, useEffect } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';
import type { ListModelsResult } from '../../../../packages/agent/src/protocol.ts';

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
export function useHarnessCatalog(): { refresh: () => void } {
  const client = useAgentClient();
  const agentStatus = useAppStore(state => state.agentStatus);
  const modelCatalog = useAppStore(state => state.modelCatalog);
  const setModelCatalog = useAppStore(state => state.setModelCatalog);
  const doctorResult = useAppStore(state => state.doctorResult);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);

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

  const refresh = useCallback(() => {
    refreshModelCatalog(client, setModelCatalog);
  }, [client, setModelCatalog]);

  return { refresh };
}
