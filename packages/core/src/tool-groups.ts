/**
 * The doctor report's two groups, in a module with NO node imports.
 *
 * Split out of tools.ts deliberately: that file reaches for
 * node:child_process (via exec.ts) to actually run a probe, which makes it
 * unbundleable for the browser — and the desktop's Doctor page needs exactly
 * these three values to lay itself out. The alternative the repo has used
 * before is duplicating constants into apps/desktop (see
 * WorkspaceSettingsPage's DEFAULT_CONFIG_LEAVES), which is a drift risk this
 * avoids: the CLI renderer, the parity parser and the desktop all read the
 * headings from here.
 */
export type ToolGroup = 'harness' | 'support';

/** Render order, everywhere: the CLI's sections, the desktop's, the RPC payload. */
export const TOOL_GROUPS: readonly ToolGroup[] = ['harness', 'support'];

/**
 * The one place these strings live. The parity suite's CLI parser matches
 * section headings against them, so a heading reworded here cannot silently
 * break the parse.
 */
export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  harness: 'AI harnesses',
  support: 'Support tools',
};
