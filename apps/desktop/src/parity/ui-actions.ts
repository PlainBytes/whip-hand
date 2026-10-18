/**
 * Maps every entry in the CLI surface (parity/fixtures/cli-surface.json) to
 * the UI element that exercises it, so parity/surface.test.ts fails the build
 * when the CLI and desktop UI drift apart. Pure data — no React/Tauri imports.
 */
export const uiActions: Record<string, Record<string, string>> = {
  doctor: {
    // nav.ts's PageId 'doctor' — the Doctor page, listing adapters and
    // driving the same `doctor()` report as `whiphand doctor`.
    _command: 'page:doctor',
    // The Doctor page asks about the workspace the switcher has open.
    '-C': 'sidebar:workspaceSwitcher',
  },
  run: {
    // RunsPage's "New run" button, opening a draft tab holding NewRunForm.
    _command: 'runs:newRunButton',
    // NewRunForm's Workflow Dropdown (Field label "Workflow").
    '<workflow>': 'new-run-form:workflowDropdown',
    // NewRunForm's "Dry run (no side effects)" Switch.
    '--dry-run': 'new-run-form:dryRunSwitch',
    // NewRunForm's generated Field/Input per workflow input, driving startRun's `inputs`.
    '--input': 'new-run-form:inputForm',
    // NewRunForm's "Attachments" field — Add files…, drop, or paste an
    // image — driving startRun's `attachments`.
    '--attach': 'new-run-form:attachmentsField',
    // components/WorkspaceSwitcher.tsx, at the top of the sidebar — sets the
    // workspace path used as startRun's `workdir`, the UI's equivalent of
    // `-C <dir>`.
    '-C': 'sidebar:workspaceSwitcher',
    // NDJSON machine-readable output mode: a CLI-only concern, no UI surface.
    '--json': 'exempt:machine-readable-output',
    // Auto-resolving a human gate only makes sense where there is no human.
    // The desktop always has one — it shows the ManualStepCard instead.
    '--yes': 'exempt:non-interactive-automation',
    // NewRunForm's "Max loop iterations" Field/SpinButton, driving startRun's
    // `maxIterations`.
    '--max-iterations': 'new-run-form:maxIterationsInput',
    // NewRunForm's "Run in a separate worktree" Switch, driving startRun's
    // `worktree`. The switch sends false explicitly, which is `--no-worktree`.
    '--worktree': 'new-run-form:worktreeSwitch',
    '--no-worktree': 'new-run-form:worktreeSwitch',
    // RunDetailPage's "Continue in worktree" button (added with the desktop
    // stage of this feature), driving startRun's `continueIn`.
    '--in-worktree': 'run-detail:continueInWorktreeButton',
    // NewRunForm's "Name (optional)" Field/Input, driving startRun's `name`.
    '--name': 'new-run-form:nameInput',
    // RunDetailPage's "Resume" button, shown for a failed, interrupted or
    // cancelled run and driving the resumeRun RPC.
    '--resume': 'run-detail:resumeButton',
    // The same button's menu, for when the recorded agent session is gone and
    // continuing it would fail — drives resumeRun's `freshSession`.
    '--fresh-session': 'run-detail:resumeFreshSessionMenuItem',
    // The same button's menu, "Resume with more iterations…" — opens a dialog
    // whose Input drives resumeRun's `extraIterations`.
    '--extra-iterations': 'run-detail:resumeExtraIterationsInput',
  },
  'rename-run': {
    // RunDetailPage's "Rename" button beside Lock/Delete, opening the rename
    // dialog that drives the renameRun RPC.
    _command: 'run-detail:renameButton',
    // The CLI names the run to rename; the UI has already selected one by
    // being open on its detail page, so there is no field for the id.
    '<runId>': 'exempt:run-selected-by-opening-its-detail-page',
    // The rename dialog's Input; clearing it and saving clears the name, the
    // same thing `whiphand rename-run <id> ''` does.
    '<name>': 'run-detail:renameInput',
    '-C': 'sidebar:workspaceSwitcher',
  },
  init: {
    // WorkflowsPage empty state's "Set up this workspace" button.
    _command: 'workflows:setUpWorkspaceButton',
    '-C': 'sidebar:workspaceSwitcher',
  },
  'new-workflow': {
    // WorkflowsPage's "New workflow" dialog.
    _command: 'workflows:newWorkflowButton',
    '<name>': 'workflows:newWorkflowNameInput',
    '-C': 'sidebar:workspaceSwitcher',
    // The dialog's Project/Global choice, driving createWorkflow's `scope`.
    '--global': 'workflows:newWorkflowScopeChoice',
  },
  // Removing a worktree on its own has no desktop button yet; deleting the run
  // removes its worktree too, and refuses while it holds uncommitted changes.
  'worktree remove': {
    _command: 'exempt:cli-only-the-delete-run-dialog-removes-worktrees',
    '<runId>': 'exempt:cli-only',
    '--force': 'exempt:cli-only',
    '-C': 'sidebar:workspaceSwitcher',
  },
  // `whiphand config get`/`whiphand config set` are the CLI's half of the global-config
  // layering the desktop reads/writes through configGet/configSet — a
  // dotted key and a raw value have no single UI field each maps onto, since
  // the UI exposes every setting as its own dedicated control rather than a
  // generic key/value pair (see WorkspaceSettingsPage and PreferencesPage).
  'config get': {
    _command: 'exempt:read-only-cli-inspection',
    '<key>': 'exempt:generic-key-no-dedicated-ui-field',
    '--global': 'preferences:globalConfigSection',
    '-C': 'sidebar:workspaceSwitcher',
  },
  'config set': {
    // WorkspaceSettingsPage's Save button writes the merged form back via
    // configSet — the UI's equivalent of `whiphand config set` for the project
    // layer; PreferencesPage's global config controls are the --global one.
    _command: 'workspace-settings:saveButton',
    '<key>': 'exempt:generic-key-no-dedicated-ui-field',
    '<value>': 'exempt:generic-key-no-dedicated-ui-field',
    '--global': 'preferences:globalConfigSection',
    '-C': 'sidebar:workspaceSwitcher',
  },
  // `whiphand tui` is another front end on the same agent, not an action
  // inside this one (docs/tui-plan.md); the window itself is its counterpart.
  tui: {
    _command: 'exempt:another-front-end',
    '-C': 'sidebar:workspaceSwitcher',
  },
  // `whiphand desktop` starts this app; inside it there is nothing to map.
  desktop: {
    _command: 'exempt:starts-this-app',
  },
};
