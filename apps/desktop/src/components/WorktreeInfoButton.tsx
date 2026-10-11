/**
 * Icon button in the run header that opens a popover with the run's worktree
 * branch and path, each with a copy button — the two values people paste into
 * a terminal. Keeps the header to one row instead of printing them inline.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import {
  BranchFork20Regular, Checkmark20Regular, Copy20Regular, ErrorCircle20Regular,
} from '@fluentui/react-icons';

type CopyState = 'idle' | 'copied' | 'failed';

export interface WorktreeInfoButtonProps {
  worktree: { path: string; branch: string };
}

interface CopyRowProps {
  title: string;
  value: string;
  /** Idle label of the copy button, e.g. "Copy branch". */
  copyLabel: string;
  testId: string;
}

function CopyRow({ title, value, copyLabel, testId }: CopyRowProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Reset after a moment, and never leave a timer running past unmount.
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopyState('copied');
      } catch {
        // A webview can refuse clipboard access; say so rather than
        // showing "Copied" over a clipboard that never changed.
        setCopyState('failed');
      }
    })();
  }, [value]);

  const label = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : copyLabel;
  const icon = copyState === 'copied'
    ? <Checkmark20Regular />
    : copyState === 'failed' ? <ErrorCircle20Regular /> : <Copy20Regular />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>{title}</Text>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Text
          data-testid={testId}
          style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}
        >
          {value}
        </Text>
        <Tooltip content={label} relationship="label">
          <Button appearance="subtle" size="small" icon={icon} onClick={copy} />
        </Tooltip>
      </div>
    </div>
  );
}

export function WorktreeInfoButton({ worktree }: WorktreeInfoButtonProps) {
  return (
    <Popover positioning="below-end">
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content="Worktree details" relationship="label">
          <Button
            data-testid="run-detail-worktree"
            appearance="subtle"
            size="small"
            icon={<BranchFork20Regular />}
          />
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}>
          <CopyRow
            title="Branch"
            value={worktree.branch}
            copyLabel="Copy branch"
            testId="run-detail-worktree-branch"
          />
          <CopyRow
            title="Path"
            value={worktree.path}
            copyLabel="Copy path"
            testId="run-detail-worktree-path"
          />
        </div>
      </PopoverSurface>
    </Popover>
  );
}
