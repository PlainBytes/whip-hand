/**
 * The one way any UI code opens a workspace, so the recent list stays
 * consistent and — the reason this lives apart from useStartupRestore — the
 * unsaved-edits guard runs on every path into a switch. Switching is reachable
 * from the sidebar switcher, the welcome screen, an Activity row and Ctrl+K;
 * guarding here covers all four, where guarding in App covered none of them.
 */
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';

/**
 * The switch waiting on the human, if any. The resolve function is kept
 * module-local rather than in the store: a promise's continuation is not
 * application state, and stringifying one into a devtools snapshot helps
 * nobody. The store carries only the path, so App knows to mount the dialog.
 */
let pending: { settle: (confirmed: boolean) => void } | null = null;

/**
 * Opens `path`, first asking about unsaved edits if there are any.
 *
 * Resolves true when the workspace actually changed and false when the user
 * chose to keep editing — callers that navigate afterwards must check, or
 * they will navigate into a workspace they did not switch to. Still *throws*
 * when the agent refuses the path, so existing error handling is unchanged.
 */
export async function openWorkspace(client: AgentClient, path: string): Promise<boolean> {
  if (useAppStore.getState().filesDirty) {
    const confirmed = await new Promise<boolean>(settle => {
      // A second request supersedes the first: the newest click is the one
      // the human meant, and two stacked dialogs is the Modalizer race.
      pending?.settle(false);
      pending = { settle };
      useAppStore.getState().setPendingWorkspaceSwitch(path);
    });
    if (!confirmed) return false;
    useAppStore.getState().setFilesDirty(false);
  }

  const { recentWorkspaces } = await client.request('touchRecentWorkspace', { path });
  const store = useAppStore.getState();
  // The agent resolved the path; adopt its canonical form (list head).
  store.setWorkspacePath(recentWorkspaces[0]?.path ?? path);
  store.patchAppState({ recentWorkspaces });
  return true;
}

/** Answers the pending guard dialog. */
export function settlePendingWorkspaceSwitch(confirmed: boolean): void {
  const current = pending;
  pending = null;
  useAppStore.getState().setPendingWorkspaceSwitch(null);
  current?.settle(confirmed);
}
