import { workspaceColorVar } from '../lib/workspace-identity.ts';

/**
 * The workspace's colour chip. aria-hidden because the label beside it
 * already names the workspace, and a colour is not something a screen
 * reader can convey.
 *
 * 16px by default — big enough to read as a colour at a glance, while still
 * centring inside the 20px `RowGlyph` slot so it stays on the nav icon column.
 */
export function WorkspaceDot({ path, identityKey, size = 16 }: { path: string; identityKey?: string | undefined; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `var(${workspaceColorVar(path, identityKey)})`,
        flexShrink: 0,
      }}
    />
  );
}
