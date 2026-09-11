/**
 * Maps every entry in the CLI surface (see parity/extract-cli-surface.ts) to
 * the UI element that exercises it, so parity/surface.test.ts can fail the
 * build the moment the CLI and the desktop UI drift apart.
 *
 * Deliberately pure data: no React or Tauri imports, so it stays importable
 * from a plain `node --test` run. Values are human-readable labels, not
 * literal component/prop identifiers — but they must describe something
 * real in apps/desktop/src (cross-checked against App.tsx and the page
 * components).
 *
 * Each command entry:
 *   - `_command`: the UI surface that starts this CLI command at all.
 *   - one key per arg (`<name>`) and per option (long flag, or short flag
 *     when there's no long form) — value is either the UI element that
 *     drives it, or `exempt:<reason>` for CLI-only concerns with no UI
 *     equivalent (e.g. machine-readable output modes).
 */
export const uiActions: Record<string, Record<string, string>> = {
  doctor: {
    // nav.ts's PageId 'doctor' — the Doctor page, listing adapters and
    // driving the same `doctor()` report as `whiphand doctor`.
    _command: 'page:doctor',
  },
  run: {
    // RunsPage's "New run" button, opening NewRunDialog.
    _command: 'runs:newRunButton',
    // NewRunDialog's Workflow Dropdown (Field label "Workflow").
    '<workflow>': 'new-run-dialog:workflowDropdown',
    // NewRunDialog's "Dry run (no side effects)" Switch.
    '--dry-run': 'new-run-dialog:dryRunSwitch',
    // NewRunDialog's generated Field/Input per workflow input, driving startRun's `inputs`.
    '--input': 'new-run-dialog:inputForm',
    // NewRunDialog's "Attachments" field — Add files…, drop, or paste an
    // image — driving startRun's `attachments`.
    '--attach': 'new-run-dialog:attachmentsField',
    // components/WorkspaceSwitcher.tsx, at the top of the sidebar — sets the
    // workspace path used as startRun's `workdir`, the UI's equivalent of
    // `-C <dir>`.
    '-C': 'sidebar:workspaceSwitcher',
    // NDJSON machine-readable output mode: a CLI-only concern, no UI surface.
    '--json': 'exempt:machine-readable-output',
    // Auto-resolving a human gate only makes sense where there is no human.
    // The desktop always has one — it shows the ManualStepCard instead.
    '--yes': 'exempt:non-interactive-automation',
    // NewRunDialog's "Max loop iterations" Field/SpinButton, driving startRun's
    // `maxIterations`.
    '--max-iterations': 'new-run-dialog:maxIterationsInput',
    // NewRunDialog's "Name (optional)" Field/Input, driving startRun's `name`.
    '--name': 'new-run-dialog:nameInput',
    // RunDetailPage's "Resume" button, shown for a failed, interrupted or
    // cancelled run and driving the resumeRun RPC.
    '--resume': 'run-detail:resumeButton',
    // The same button's menu, for when the recorded agent session is gone and
    // continuing it would fail — drives resumeRun's `freshSession`.
    '--fresh-session': 'run-detail:resumeFreshSessionMenuItem',
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
    // WorkflowsPage empty state's "Set up this workspace" button (Task 12).
    _command: 'workflows:setUpWorkspaceButton',
    '-C': 'sidebar:workspaceSwitcher',
  },
  'new-workflow': {
    // WorkflowsPage's "New workflow" dialog (Task 12).
    _command: 'workflows:newWorkflowButton',
    '<name>': 'workflows:newWorkflowNameInput',
    '-C': 'sidebar:workspaceSwitcher',
    // The dialog's Project/Global choice, driving createWorkflow's `scope`.
    '--global': 'workflows:newWorkflowScopeChoice',
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
};
