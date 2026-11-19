/**
 * The file tree and its preview, as one layout shared by the Files page and a
 * run's artifacts tab.
 *
 * Wide: the tree on the left in a ResizablePane, the preview on the right.
 *
 * Narrow (a phone): list → detail. The tree takes the full width until a file
 * is selected; then only the preview shows, under a "Back to files" button.
 * The preview is unmounted rather than hidden when there is no selection, and
 * Back is the parent's `onBack`: the parent owns the selection and the
 * unsaved-draft guard, so it decides whether Back clears the selection now or
 * asks first.
 */
import type { ReactNode } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeft20Regular } from '@fluentui/react-icons';
import { useNarrowLayout } from '../lib/use-narrow-layout.ts';
import { RECESSED_SURFACE } from './recessed-surface.ts';
import { ResizablePane } from './ResizablePane.tsx';

export interface TreePreviewSplitProps {
  tree: ReactNode;
  preview: ReactNode;
  /** True when a file (not a directory, not nothing) is open in the preview. */
  hasSelection: boolean;
  onBack: () => void;
  /** localStorage key of the wide layout's tree width. */
  storageKey: string;
}

export function TreePreviewSplit({ tree, preview, hasSelection, onBack, storageKey }: TreePreviewSplitProps) {
  const narrow = useNarrowLayout();

  if (!narrow) {
    return (
      <div style={{ display: 'flex', flex: 1, width: '100%', minWidth: 0, minHeight: 0 }}>
        <ResizablePane storageKey={storageKey}>{tree}</ResizablePane>
        <div
          style={{
            // The recessed surface is the only boundary; the tree sits on the
            // page background with a resize handle before it.
            ...RECESSED_SURFACE,
            flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden',
          }}
        >
          {preview}
        </div>
      </div>
    );
  }

  if (!hasSelection) {
    return (
      <div
        data-testid="tree-preview-tree"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, width: '100%', minWidth: 0, minHeight: 0, overflow: 'auto' }}
      >
        {tree}
      </div>
    );
  }

  return (
    <div
      data-testid="tree-preview-detail"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, width: '100%', minWidth: 0, minHeight: 0 }}
    >
      <div style={{ flexShrink: 0 }}>
        <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onBack}>
          Back to files
        </Button>
      </div>
      <div
        style={{
          ...RECESSED_SURFACE,
          flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden',
        }}
      >
        {preview}
      </div>
    </div>
  );
}
