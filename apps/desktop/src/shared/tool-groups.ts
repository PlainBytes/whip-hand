/**
 * The doctor report's two groups and their headings, as whiphand-core's
 * doctor/tools.rs reports them; the Doctor page lays itself out by these.
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
