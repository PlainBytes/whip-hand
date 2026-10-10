import type { AppState } from '../shared/protocol.gen.ts';

/** What the agent reports before anything has been saved. */
export const EMPTY_APP_STATE: AppState = {
  schemaVersion: 1,
  recentWorkspaces: [],
  window: null,
  lastPage: null,
  theme: 'system',
  workspaces: {},
  runsRetention: { maxPerWorkspace: 0 },
  showOngoingRuns: true,
  editor: { kind: 'vscode' },
};
