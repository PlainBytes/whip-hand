import { workspaceColorVar } from '../lib/workspace-identity.ts';

/**
 * The workspace's colour chip. aria-hidden because the label beside it
 * already names the workspace, and a colour is not something a screen
 * reader can convey.
 */
export function WorkspaceDot({ path, size = 8 }: { path: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `var(${workspaceColorVar(path)})`,
        flexShrink: 0,
      }}
    />
  );
}
